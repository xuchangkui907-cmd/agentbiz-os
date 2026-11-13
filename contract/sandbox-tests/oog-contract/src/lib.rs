use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::serde_json;
use near_sdk::{
    env, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const CALLBACK_GAS: u64 = 1;

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Escrows,
    Agents,
    FinanceApprovers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [json, borsh])]
pub enum EscrowStatus {
    Open,
    Submitted,
    Approved,
    Releasing,
    Refunding,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
pub struct Escrow {
    pub payer: AccountId,
    pub supplier: AccountId,
    pub amount: U128,
    pub submitted_hash: Option<String>,
    pub status: EscrowStatus,

    // Monotonically increasing identifier for each transfer attempt.
    pub release_attempt: u64,

    // First independent finance approver's reconciliation vote.
    pub reconciliation_first_approver: Option<AccountId>,
    pub reconciliation_outcome: Option<bool>,
    pub reconciliation_evidence_hash: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    paused: bool,
    max_budget: u128,

    // NEAR funds available in the enterprise central treasury.
    treasury_available: u128,

    // Successfully paid procurement expenditure.
    spent_total: u128,

    // Funds reserved by all non-finalized escrows.
    total_locked: u128,

    escrows: LookupMap<String, Escrow>,

    // Authorized agent account -> per-order spending limit.
    agents: LookupMap<AccountId, u128>,

    // Independently authorized finance approver accounts.
    finance_approvers: LookupMap<AccountId, bool>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, max_budget: U128) -> Self {
        require!(max_budget.0 > 0, "ERR_BUDGET");

        Self {
            owner,
            paused: false,
            max_budget: max_budget.0,
            treasury_available: 0,
            spent_total: 0,
            total_locked: 0,
            escrows: LookupMap::new(StorageKey::Escrows),
            agents: LookupMap::new(StorageKey::Agents),
            finance_approvers: LookupMap::new(StorageKey::FinanceApprovers),
        }
    }

    // Owner deposits NEAR into the enterprise procurement treasury.
    #[payable]
    pub fn deposit(&mut self) {
        self.assert_owner();

        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_DEPOSIT");

        // account_balance includes the attached deposit. Determine the
        // pre-deposit balance so storage collateral deficits are repaired
        // before any funds are credited to the procurement treasury.
        let balance_after_deposit = env::account_balance().as_yoctonear();
        let balance_before_deposit = balance_after_deposit
            .checked_sub(amount)
            .expect("ERR_BALANCE_ACCOUNTING");

        let required_before_deposit = self.required_liquid_balance();
        let deficit = required_before_deposit.saturating_sub(balance_before_deposit);
        let treasury_credit = amount.saturating_sub(deficit);

        self.treasury_available = self
            .treasury_available
            .checked_add(treasury_credit)
            .expect("ERR_TREASURY_OVERFLOW");

        env::log_str(&format!(
            "AGENTBIZ|TREASURY_DEPOSITED|{}|{}|{}|{}",
            env::predecessor_account_id(),
            amount,
            deficit,
            treasury_credit
        ));
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        env::log_str(if paused {
            "AGENTBIZ|PAUSED"
        } else {
            "AGENTBIZ|UNPAUSED"
        });
    }

    pub fn set_max_budget(&mut self, max_budget: U128) {
        self.assert_owner();
        require!(max_budget.0 > 0, "ERR_BUDGET");

        let committed = self.committed_amount();
        require!(max_budget.0 >= committed, "ERR_BELOW_COMMITTED");

        self.max_budget = max_budget.0;
    }

    // Enable or disable an agent.
    // A zero limit is not accepted when enabling an agent.
    pub fn set_agent(&mut self, agent: AccountId, enabled: bool, per_order_limit: U128) {
        self.assert_owner();

        if enabled {
            require!(agent != self.owner, "ERR_ROLE_CONFLICT");
            require!(
                !self.finance_approvers.get(&agent).unwrap_or(false),
                "ERR_ROLE_CONFLICT"
            );
            require!(per_order_limit.0 > 0, "ERR_AGENT_LIMIT");
            require!(per_order_limit.0 <= self.max_budget, "ERR_AGENT_LIMIT");
            self.agents.insert(&agent, &per_order_limit.0);
            self.assert_treasury_solvent();
        } else {
            self.agents.remove(&agent);
        }
    }

    // Owner manages the independent finance approver allowlist.
    pub fn set_finance_approver(&mut self, account: AccountId, enabled: bool) {
        self.assert_owner();

        require!(
            account != env::current_account_id(),
            "ERR_INVALID_FINANCE_ACCOUNT"
        );

        if enabled {
            require!(account != self.owner, "ERR_ROLE_CONFLICT");
            require!(self.agents.get(&account).is_none(), "ERR_ROLE_CONFLICT");
            self.finance_approvers.insert(&account, &true);
            self.assert_treasury_solvent();
        } else {
            self.finance_approvers.remove(&account);
        }

        env::log_str(&format!(
            "AGENTBIZ|FINANCE_APPROVER_CHANGED|{}|{}",
            account, enabled
        ));
    }

    // Start a new budget period.
    // Existing locked escrows must be settled first.
    pub fn reset_spent_total(&mut self) {
        self.assert_owner();
        require!(self.total_locked == 0, "ERR_ESCROWS_PENDING");
        self.spent_total = 0;
    }

    // The enterprise treasury funds the escrow.
    // The authorized caller creates the order but does not fund it personally.
    pub fn create_escrow(&mut self, order_id: String, supplier: AccountId, amount: U128) {
        self.assert_active();

        require!(
            !order_id.is_empty() && order_id.len() <= 128,
            "ERR_ORDER_ID"
        );
        require!(self.escrows.get(&order_id).is_none(), "ERR_EXISTS");
        require!(amount.0 > 0, "ERR_AMOUNT");

        let payer = env::predecessor_account_id();

        // Owner or explicitly authorized agent only.
        let limit = if payer == self.owner {
            self.max_budget
        } else {
            self.agents.get(&payer).unwrap_or(0)
        };

        require!(limit > 0, "ERR_NOT_AUTHORIZED");
        require!(amount.0 <= limit, "ERR_AGENT_LIMIT");
        require!(amount.0 <= self.max_budget, "ERR_OVER_BUDGET");

        require!(
            supplier != env::current_account_id(),
            "ERR_INVALID_SUPPLIER"
        );

        // Cumulative budget:
        // successfully paid + currently locked + new order.
        let new_committed = self
            .committed_amount()
            .checked_add(amount.0)
            .expect("ERR_OVERFLOW");

        require!(new_committed <= self.max_budget, "ERR_OVER_BUDGET");

        require!(
            self.treasury_available >= amount.0,
            "ERR_INSUFFICIENT_TREASURY"
        );

        self.treasury_available = self
            .treasury_available
            .checked_sub(amount.0)
            .expect("ERR_TREASURY_ACCOUNTING");

        self.total_locked = self
            .total_locked
            .checked_add(amount.0)
            .expect("ERR_OVERFLOW");

        self.escrows.insert(
            &order_id,
            &Escrow {
                payer: payer.clone(),
                supplier: supplier.clone(),
                amount,
                submitted_hash: None,
                status: EscrowStatus::Open,
                release_attempt: 0,
                reconciliation_first_approver: None,
                reconciliation_outcome: None,
                reconciliation_evidence_hash: None,
            },
        );

        self.assert_treasury_solvent();

        env::log_str(&format!(
            "AGENTBIZ|ESCROW_CREATED|{}|{}|{}",
            order_id, payer, amount.0
        ));
    }

    // Supplier submits a 32-byte SHA-256 digest as 64 hex characters.
    pub fn submit_delivery(&mut self, order_id: String, sha256_hex: String) {
        self.assert_active();

        let normalized_hash = Self::normalize_hash(&sha256_hex);

        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");

        require!(
            env::predecessor_account_id() == escrow.supplier,
            "ERR_SUPPLIER"
        );
        require!(escrow.status == EscrowStatus::Open, "ERR_STATE");

        escrow.submitted_hash = Some(normalized_hash);
        escrow.status = EscrowStatus::Submitted;

        self.escrows.insert(&order_id, &escrow);

        self.assert_treasury_solvent();

        env::log_str(&format!("AGENTBIZ|DELIVERY_SUBMITTED|{}", order_id));
    }

    // The payer (or owner) independently verifies the delivered file
    // off-chain and submits its locally calculated SHA-256.
    // Supplier cannot approve its own delivery.
    pub fn approve_delivery(&mut self, order_id: String, verified_sha256_hex: String) {
        self.assert_active();

        let verified_hash = Self::normalize_hash(&verified_sha256_hex);

        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");

        let caller = env::predecessor_account_id();

        require!(caller != escrow.payer, "ERR_SELF_APPROVAL");
        self.assert_finance_authorized(&caller);
        require!(escrow.status == EscrowStatus::Submitted, "ERR_STATE");

        let submitted_hash = escrow.submitted_hash.as_ref().expect("ERR_NO_DELIVERY");

        require!(*submitted_hash == verified_hash, "ERR_HASH_MISMATCH");

        escrow.status = EscrowStatus::Approved;
        self.escrows.insert(&order_id, &escrow);

        env::log_str(&format!("AGENTBIZ|DELIVERY_APPROVED|{}", order_id));
    }

    // Release is only possible after independent hash approval.
    // Final state is written only after the transfer callback succeeds.
    pub fn release(&mut self, order_id: String) -> Promise {
        self.assert_active();

        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");
        let caller = env::predecessor_account_id();

        require!(caller != escrow.payer, "ERR_SELF_APPROVAL");
        self.assert_finance_authorized(&caller);
        require!(escrow.status == EscrowStatus::Approved, "ERR_STATE");

        self.assert_treasury_solvent();

        escrow.release_attempt = escrow
            .release_attempt
            .checked_add(1)
            .expect("ERR_RELEASE_ATTEMPT_OVERFLOW");

        // A new attempt must never inherit votes from an older attempt.
        escrow.reconciliation_first_approver = None;
        escrow.reconciliation_outcome = None;
        escrow.reconciliation_evidence_hash = None;

        escrow.status = EscrowStatus::Releasing;

        let attempt = escrow.release_attempt;
        let supplier = escrow.supplier.clone();
        let amount = escrow.amount.0;

        self.escrows.insert(&order_id, &escrow);

        let callback_args = serde_json::to_vec(&serde_json::json!({
            "order_id": order_id,
            "attempt": attempt
        }))
        .expect("ERR_CALLBACK_ARGS");

        let callback = Promise::new(env::current_account_id()).function_call(
            "on_release_complete".to_string(),
            callback_args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(CALLBACK_GAS),
        );

        env::log_str(&format!(
            "AGENTBIZ|RELEASE_STARTED|{}|{}",
            order_id, attempt
        ));

        Promise::new(supplier)
            .transfer(NearToken::from_yoctonear(amount))
            .then(callback)
    }

    // Reconcile a transfer whose callback receipt did not complete.
    //
    // Two distinct currently-authorized finance accounts must independently
    // submit the same outcome and evidence hash for the same attempt.
    // This is a governance attestation, not an on-chain proof of RPC evidence.
    pub fn reconcile_release(
        &mut self,
        order_id: String,
        attempt: u64,
        transfer_succeeded: bool,
        evidence_hash: String,
    ) {
        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");
        let caller = env::predecessor_account_id();

        require!(caller != escrow.payer, "ERR_SELF_APPROVAL");
        self.assert_finance_authorized(&caller);
        require!(escrow.status == EscrowStatus::Releasing, "ERR_STATE");
        require!(attempt == escrow.release_attempt, "ERR_RELEASE_ATTEMPT");

        let evidence_hash = Self::normalize_hash(&evidence_hash);

        match (
            escrow.reconciliation_first_approver.clone(),
            escrow.reconciliation_outcome,
            escrow.reconciliation_evidence_hash.clone(),
        ) {
            (None, None, None) => {
                escrow.reconciliation_first_approver = Some(caller.clone());
                escrow.reconciliation_outcome = Some(transfer_succeeded);
                escrow.reconciliation_evidence_hash = Some(evidence_hash);

                self.escrows.insert(&order_id, &escrow);
                self.assert_treasury_solvent();

                env::log_str(&format!(
                    "AGENTBIZ|RECONCILIATION_FIRST_VOTE|{}|{}|{}",
                    order_id, attempt, caller
                ));
            }
            (Some(first_approver), Some(first_outcome), Some(first_hash)) => {
                require!(caller != first_approver, "ERR_DUPLICATE_APPROVER");

                // The first approver must still be authorized at finalization.
                self.assert_finance_authorized(&first_approver);

                require!(
                    first_outcome == transfer_succeeded,
                    "ERR_RECONCILIATION_CONFLICT"
                );
                require!(first_hash == evidence_hash, "ERR_EVIDENCE_MISMATCH");

                if transfer_succeeded {
                    escrow.status = EscrowStatus::Released;

                    self.total_locked = self
                        .total_locked
                        .checked_sub(escrow.amount.0)
                        .expect("ERR_ACCOUNTING");

                    self.spent_total = self
                        .spent_total
                        .checked_add(escrow.amount.0)
                        .expect("ERR_ACCOUNTING");
                } else {
                    // Transfer failure is attested by two independent voters.
                    // Funds remain locked and a new release attempt is allowed.
                    escrow.status = EscrowStatus::Approved;
                }

                escrow.reconciliation_first_approver = None;
                escrow.reconciliation_outcome = None;
                escrow.reconciliation_evidence_hash = None;

                self.escrows.insert(&order_id, &escrow);

                env::log_str(&format!(
                    "AGENTBIZ|RECONCILIATION_FINALIZED|{}|{}|{}",
                    order_id, attempt, transfer_succeeded
                ));
            }
            _ => {
                env::panic_str("ERR_RECONCILIATION_STATE");
            }
        }
    }

    // Refund returns the locked amount to the enterprise treasury ledger.
    // No external transfer is made because the treasury funded the escrow.
    // This remains available while the contract is paused.
    pub fn refund(&mut self, order_id: String) {
        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");

        let caller = env::predecessor_account_id();

        require!(caller != escrow.payer, "ERR_SELF_APPROVAL");
        self.assert_finance_authorized(&caller);

        require!(
            escrow.status == EscrowStatus::Open || escrow.status == EscrowStatus::Submitted,
            "ERR_STATE"
        );

        let amount = escrow.amount.0;

        self.total_locked = self
            .total_locked
            .checked_sub(amount)
            .expect("ERR_ACCOUNTING");

        self.treasury_available = self
            .treasury_available
            .checked_add(amount)
            .expect("ERR_TREASURY_OVERFLOW");

        escrow.status = EscrowStatus::Refunded;
        self.escrows.insert(&order_id, &escrow);

        env::log_str(&format!(
            "AGENTBIZ|REFUND_CONFIRMED|{}|{}",
            order_id, amount
        ));
    }

    // Private callback: only this contract can invoke it.
    #[private]
    pub fn on_release_complete(
        &mut self,
        order_id: String,
        attempt: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        // TEST ONLY: consume callback gas through runtime SHA-256 host calls.
        // Each iteration depends on the previous digest, preventing loop elimination.
        if env::predecessor_account_id() == env::current_account_id() {
            env::log_str("OOG_TEST|CALLBACK_GAS_BURN|START");

            let mut digest = env::sha256(order_id.as_bytes());

            for _ in 0..1_000_000u64 {
                digest = env::sha256(&digest);
            }

            env::log_str("OOG_TEST|CALLBACK_GAS_BURN|COMPLETED");
        }

        let mut escrow = self.escrows.get(&order_id).expect("ERR_ESCROW");

        // A delayed callback from an older attempt must be harmless.
        if attempt != escrow.release_attempt || escrow.status != EscrowStatus::Releasing {
            env::log_str(&format!(
                "AGENTBIZ|STALE_RELEASE_CALLBACK|{}|{}",
                order_id, attempt
            ));
            return;
        }

        match result {
            Ok(()) => {
                escrow.status = EscrowStatus::Released;

                self.total_locked = self
                    .total_locked
                    .checked_sub(escrow.amount.0)
                    .expect("ERR_ACCOUNTING");

                self.spent_total = self
                    .spent_total
                    .checked_add(escrow.amount.0)
                    .expect("ERR_ACCOUNTING");

                env::log_str(&format!("AGENTBIZ|RELEASE_CONFIRMED|{}", order_id));
            }
            Err(_) => {
                // Transfer failed. Funds remain locked and can be retried.
                escrow.status = EscrowStatus::Approved;

                env::log_str(&format!("AGENTBIZ|RELEASE_FAILED|{}", order_id));
            }
        }

        self.escrows.insert(&order_id, &escrow);
    }

    // Read methods.
    pub fn get_escrow(&self, order_id: String) -> Option<Escrow> {
        self.escrows.get(&order_id)
    }

    pub fn get_max_budget(&self) -> U128 {
        U128(self.max_budget)
    }

    pub fn get_spent_total(&self) -> U128 {
        U128(self.spent_total)
    }

    pub fn get_total_locked(&self) -> U128 {
        U128(self.total_locked)
    }

    pub fn get_treasury_available(&self) -> U128 {
        U128(self.treasury_available)
    }

    // Available procurement capacity is constrained by both the budget
    // remaining and the actual amount allocated to the treasury ledger.
    pub fn get_available_budget(&self) -> U128 {
        let budget_remaining = self
            .max_budget
            .saturating_sub(self.spent_total)
            .saturating_sub(self.total_locked);

        U128(budget_remaining.min(self.treasury_available))
    }

    pub fn get_agent_limit(&self, agent: AccountId) -> U128 {
        U128(self.agents.get(&agent).unwrap_or(0))
    }

    pub fn is_finance_approver(&self, account: AccountId) -> bool {
        account == self.owner || self.finance_approvers.get(&account).unwrap_or(false)
    }

    pub fn get_paused(&self) -> bool {
        self.paused
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_OWNER");
    }

    fn assert_active(&self) {
        require!(!self.paused, "ERR_PAUSED");
    }

    fn assert_finance_authorized(&self, caller: &AccountId) {
        require!(
            caller == &self.owner || self.finance_approvers.get(caller).unwrap_or(false),
            "ERR_FINANCE_AUTH"
        );
    }

    // Storage collateral that must be covered by liquid account balance.
    // Locked NEAR balance may contribute to storage collateral, but is never
    // counted as spendable procurement liquidity.
    fn storage_liquid_reserve(&self) -> u128 {
        let required_storage = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("ERR_STORAGE_COST_OVERFLOW");

        required_storage.saturating_sub(env::account_locked_balance().as_yoctonear())
    }

    // Liquid balance required to cover both storage collateral and the
    // treasury's available and locked procurement liabilities.
    fn required_liquid_balance(&self) -> u128 {
        self.storage_liquid_reserve()
            .checked_add(self.treasury_available)
            .and_then(|v| v.checked_add(self.total_locked))
            .expect("ERR_BALANCE_REQUIREMENT_OVERFLOW")
    }

    fn assert_treasury_solvent(&self) {
        require!(
            env::account_balance().as_yoctonear() >= self.required_liquid_balance(),
            "ERR_TREASURY_UNDERCOLLATERALIZED"
        );
    }

    fn committed_amount(&self) -> u128 {
        self.spent_total
            .checked_add(self.total_locked)
            .expect("ERR_ACCOUNTING")
    }

    fn normalize_hash(hash: &str) -> String {
        require!(hash.len() == 64, "ERR_HASH_LENGTH");
        require!(
            hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "ERR_HASH_FORMAT"
        );

        hash.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const BUDGET: u128 = 40;
    const ORDER_AMOUNT: u128 = 25;

    fn set_context(predecessor: AccountId, deposit: u128) {
        let mut builder = VMContextBuilder::new();

        builder
            .current_account_id(accounts(5))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit));

        testing_env!(builder.build());
    }

    fn set_context_with_balances(
        predecessor: AccountId,
        attached_deposit: u128,
        account_balance: u128,
        locked_balance: u128,
        storage_usage: u64,
    ) {
        let mut builder = VMContextBuilder::new();

        builder
            .current_account_id(accounts(5))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .account_balance(NearToken::from_yoctonear(account_balance))
            .account_locked_balance(NearToken::from_yoctonear(locked_balance))
            .storage_usage(storage_usage)
            .attached_deposit(NearToken::from_yoctonear(attached_deposit));

        testing_env!(builder.build());
    }

    // Set the account balance to exactly one yoctoNEAR above the
    // current storage-collateral and treasury-liability requirement.
    // The next persistent write should therefore make the account insolvent.
    fn set_context_with_one_yocto_margin(
        contract: &Contract,
        predecessor: AccountId,
        storage_usage: u64,
    ) {
        set_context_with_balances(predecessor.clone(), 0, 0, 0, storage_usage);

        let required = contract.required_liquid_balance();
        let balance = required.checked_add(1).expect("test balance overflow");

        set_context_with_balances(predecessor, 0, balance, 0, storage_usage);

        assert!(
            env::account_balance().as_yoctonear() >= contract.required_liquid_balance(),
            "test setup must be solvent before the storage write"
        );
    }

    fn assert_storage_write_rejected(result: std::thread::Result<()>, storage_before: u64) {
        let payload = result.expect_err("storage write should be rejected");

        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied());

        assert_eq!(
            message,
            Some("ERR_TREASURY_UNDERCOLLATERALIZED"),
            "unexpected panic reason"
        );

        let storage_after = env::storage_usage();

        assert!(
            storage_after > storage_before,
            "persistent storage did not grow: before={}, after={}",
            storage_before,
            storage_after
        );
    }

    fn new_unfunded_contract() -> Contract {
        set_context(accounts(0), 0);
        Contract::new(accounts(0), U128(BUDGET))
    }

    fn new_contract() -> Contract {
        let mut contract = new_unfunded_contract();
        set_context(accounts(0), BUDGET);
        contract.deposit();
        contract
    }

    fn create_order(contract: &mut Contract, order_id: &str, amount: u128) {
        set_context(accounts(0), 0);
        contract.create_escrow(order_id.to_string(), accounts(1), U128(amount));
    }

    #[test]
    fn owner_can_create_funded_escrow() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-001", ORDER_AMOUNT);

        let escrow = contract.get_escrow("order-001".to_string()).unwrap();

        assert_eq!(escrow.amount.0, ORDER_AMOUNT);
        assert_eq!(escrow.payer, accounts(0));
        assert_eq!(escrow.supplier, accounts(1));
        assert_eq!(escrow.status, EscrowStatus::Open);

        assert_eq!(contract.get_total_locked().0, ORDER_AMOUNT);
        assert_eq!(contract.get_treasury_available().0, BUDGET - ORDER_AMOUNT);
        assert_eq!(contract.get_available_budget().0, BUDGET - ORDER_AMOUNT);
    }

    #[test]
    fn owner_deposit_increases_treasury_balance() {
        let mut contract = new_unfunded_contract();

        set_context(accounts(0), 17);
        contract.deposit();

        assert_eq!(contract.get_treasury_available().0, 17);
        assert_eq!(contract.get_available_budget().0, 17);
    }

    #[test]
    #[should_panic(expected = "ERR_INSUFFICIENT_TREASURY")]
    fn order_cannot_exceed_funded_treasury() {
        let mut contract = new_unfunded_contract();

        set_context(accounts(0), 0);
        contract.create_escrow(
            "order-unfunded".to_string(),
            accounts(1),
            U128(ORDER_AMOUNT),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_EXISTS")]
    fn duplicate_order_is_rejected() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-duplicate", 10);

        create_order(&mut contract, "order-duplicate", 10);
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_BUDGET")]
    fn cumulative_orders_cannot_exceed_budget() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-a", 25);
        create_order(&mut contract, "order-b", 20);
    }

    #[test]
    fn agent_can_create_order_within_limit() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);

        contract.set_agent(accounts(2), true, U128(30));

        set_context(accounts(2), 0);

        contract.create_escrow("agent-order".to_string(), accounts(1), U128(25));

        assert_eq!(contract.get_total_locked().0, 25);
        assert_eq!(contract.get_treasury_available().0, BUDGET - 25);
    }

    #[test]
    #[should_panic(expected = "ERR_SUPPLIER")]
    fn non_supplier_cannot_submit_delivery() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-delivery", 25);

        set_context(accounts(2), 0);

        contract.submit_delivery("order-delivery".to_string(), "a".repeat(64));
    }

    #[test]
    fn finance_approver_can_approve_matching_delivery_hash() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-approved", 25);

        let hash = "a".repeat(64);

        set_context(accounts(1), 0);
        contract.submit_delivery("order-approved".to_string(), hash.clone());

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);
        contract.approve_delivery("order-approved".to_string(), hash);

        let escrow = contract.get_escrow("order-approved".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Approved);
    }

    #[test]
    #[should_panic(expected = "ERR_HASH_MISMATCH")]
    fn incorrect_approval_hash_is_rejected() {
        let mut contract = new_contract();

        create_order(&mut contract, "order-bad-hash", 25);

        set_context(accounts(1), 0);

        contract.submit_delivery("order-bad-hash".to_string(), "a".repeat(64));

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);

        contract.approve_delivery("order-bad-hash".to_string(), "b".repeat(64));
    }

    // Helper: authorize an independent finance account.
    fn authorize_finance(contract: &mut Contract) {
        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), true);
    }

    // Helper: create an owner order and have an independent finance account approve it.
    fn create_approved_order(contract: &mut Contract, order_id: &str, amount: u128) {
        create_order(contract, order_id, amount);

        let hash = "a".repeat(64);

        set_context(accounts(1), 0);
        contract.submit_delivery(order_id.to_string(), hash.clone());

        authorize_finance(contract);
        set_context(accounts(3), 0);
        contract.approve_delivery(order_id.to_string(), hash);
    }

    #[test]
    #[should_panic(expected = "ERR_ROLE_CONFLICT")]
    fn agent_cannot_become_finance_approver() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));

        contract.set_finance_approver(accounts(2), true);
    }

    #[test]
    #[should_panic(expected = "ERR_ROLE_CONFLICT")]
    fn finance_approver_cannot_become_agent() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), true);

        contract.set_agent(accounts(3), true, U128(30));
    }

    #[test]
    #[should_panic(expected = "ERR_ROLE_CONFLICT")]
    fn owner_cannot_be_registered_as_agent() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(0), true, U128(30));
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn agent_cannot_approve_another_agents_order() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));
        contract.set_agent(accounts(4), true, U128(30));

        set_context(accounts(4), 0);
        contract.create_escrow("other-agent-order".to_string(), accounts(1), U128(10));

        set_context(accounts(1), 0);
        contract.submit_delivery("other-agent-order".to_string(), "a".repeat(64));

        set_context(accounts(2), 0);
        contract.approve_delivery("other-agent-order".to_string(), "a".repeat(64));
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn owner_cannot_approve_own_order() {
        let mut contract = new_contract();

        create_order(&mut contract, "owner-self-approve", 10);

        set_context(accounts(1), 0);
        contract.submit_delivery("owner-self-approve".to_string(), "a".repeat(64));

        set_context(accounts(0), 0);
        contract.approve_delivery("owner-self-approve".to_string(), "a".repeat(64));
    }

    #[test]
    fn finance_approver_can_approve_agents_order() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));
        contract.set_finance_approver(accounts(3), true);

        set_context(accounts(2), 0);
        contract.create_escrow("agent-finance-approval".to_string(), accounts(1), U128(10));

        set_context(accounts(1), 0);
        contract.submit_delivery("agent-finance-approval".to_string(), "a".repeat(64));

        set_context(accounts(3), 0);
        contract.approve_delivery("agent-finance-approval".to_string(), "a".repeat(64));

        let escrow = contract
            .get_escrow("agent-finance-approval".to_string())
            .unwrap();

        assert_eq!(escrow.status, EscrowStatus::Approved);
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn revoked_finance_approver_cannot_release() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "revoked-release", 10);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), false);

        set_context(accounts(3), 0);
        let _promise = contract.release("revoked-release".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn revoked_finance_approver_cannot_refund() {
        let mut contract = new_contract();

        create_order(&mut contract, "revoked-refund", 10);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), true);
        contract.set_finance_approver(accounts(3), false);

        set_context(accounts(3), 0);
        contract.refund("revoked-refund".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn owner_cannot_release_own_order() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "owner-self-release", 10);

        set_context(accounts(0), 0);
        let _promise = contract.release("owner-self-release".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn owner_cannot_refund_own_order() {
        let mut contract = new_contract();

        create_order(&mut contract, "owner-self-refund", 10);

        set_context(accounts(0), 0);
        contract.refund("owner-self-refund".to_string());
    }

    #[test]
    fn owner_can_authorize_and_revoke_finance_approver() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), true);
        assert!(contract.is_finance_approver(accounts(3)));

        contract.set_finance_approver(accounts(3), false);
        assert!(!contract.is_finance_approver(accounts(3)));
    }

    #[test]
    #[should_panic(expected = "ERR_OWNER")]
    fn non_owner_cannot_manage_finance_approvers() {
        let mut contract = new_contract();

        set_context(accounts(2), 0);
        contract.set_finance_approver(accounts(3), true);
    }

    #[test]
    fn owner_is_implicitly_finance_authorized() {
        let contract = new_contract();
        assert!(contract.is_finance_approver(accounts(0)));
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn agent_cannot_approve_own_order() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));

        set_context(accounts(2), 0);
        contract.create_escrow("agent-self-approve".to_string(), accounts(1), U128(10));

        set_context(accounts(1), 0);
        contract.submit_delivery("agent-self-approve".to_string(), "a".repeat(64));

        set_context(accounts(2), 0);
        contract.approve_delivery("agent-self-approve".to_string(), "a".repeat(64));
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn agent_cannot_release_own_order() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));

        set_context(accounts(2), 0);
        contract.create_escrow("agent-self-release".to_string(), accounts(1), U128(10));

        set_context(accounts(1), 0);
        contract.submit_delivery("agent-self-release".to_string(), "a".repeat(64));

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);
        contract.approve_delivery("agent-self-release".to_string(), "a".repeat(64));

        set_context(accounts(2), 0);
        let _promise = contract.release("agent-self-release".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn agent_cannot_refund_own_order() {
        let mut contract = new_contract();

        set_context(accounts(0), 0);
        contract.set_agent(accounts(2), true, U128(30));

        set_context(accounts(2), 0);
        contract.create_escrow("agent-self-refund".to_string(), accounts(1), U128(10));

        set_context(accounts(2), 0);
        contract.refund("agent-self-refund".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn revoked_finance_approver_cannot_approve() {
        let mut contract = new_contract();

        create_order(&mut contract, "revoked-finance", 10);

        set_context(accounts(1), 0);
        contract.submit_delivery("revoked-finance".to_string(), "a".repeat(64));

        authorize_finance(&mut contract);
        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), false);

        set_context(accounts(3), 0);
        contract.approve_delivery("revoked-finance".to_string(), "a".repeat(64));
    }

    #[test]
    fn release_success_updates_accounting() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "release-success", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("release-success".to_string());

        assert_eq!(
            contract
                .get_escrow("release-success".to_string())
                .unwrap()
                .status,
            EscrowStatus::Releasing
        );

        // Simulate the private callback being invoked by this contract.
        set_context(accounts(5), 0);
        contract.on_release_complete("release-success".to_string(), 1, Ok(()));

        let escrow = contract.get_escrow("release-success".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Released);
        assert_eq!(contract.get_total_locked().0, 0);
        assert_eq!(contract.get_spent_total().0, 25);
        assert_eq!(contract.get_treasury_available().0, BUDGET - 25);
        assert_eq!(contract.get_available_budget().0, 15);
    }

    #[test]
    fn release_failure_restores_approved_and_keeps_locked() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "release-failure", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("release-failure".to_string());

        set_context(accounts(5), 0);
        contract.on_release_complete("release-failure".to_string(), 1, Err(PromiseError::Failed));

        let escrow = contract.get_escrow("release-failure".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Approved);
        assert_eq!(contract.get_total_locked().0, 25);
        assert_eq!(contract.get_spent_total().0, 0);
        assert_eq!(contract.get_available_budget().0, 15);
    }

    #[test]
    fn reconciliation_success_requires_two_independent_approvers() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-success", 25);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(4), true);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-success".to_string());

        let evidence = "b".repeat(64);

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-success".to_string(), 1, true, evidence.clone());

        let pending = contract
            .get_escrow("reconcile-success".to_string())
            .unwrap();
        assert_eq!(pending.status, EscrowStatus::Releasing);
        assert_eq!(pending.reconciliation_first_approver, Some(accounts(3)));
        assert_eq!(contract.get_total_locked().0, 25);
        assert_eq!(contract.get_spent_total().0, 0);

        set_context(accounts(4), 0);
        contract.reconcile_release("reconcile-success".to_string(), 1, true, evidence);

        let settled = contract
            .get_escrow("reconcile-success".to_string())
            .unwrap();
        assert_eq!(settled.status, EscrowStatus::Released);
        assert_eq!(settled.reconciliation_first_approver, None);
        assert_eq!(contract.get_total_locked().0, 0);
        assert_eq!(contract.get_spent_total().0, 25);
        assert_eq!(contract.get_treasury_available().0, BUDGET - 25);
    }

    #[test]
    fn reconciliation_failure_restores_approved_and_allows_new_attempt() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-failure", 25);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(4), true);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-failure".to_string());

        let evidence = "c".repeat(64);

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-failure".to_string(), 1, false, evidence.clone());

        assert_eq!(
            contract
                .get_escrow("reconcile-failure".to_string())
                .unwrap()
                .status,
            EscrowStatus::Releasing
        );

        set_context(accounts(4), 0);
        contract.reconcile_release("reconcile-failure".to_string(), 1, false, evidence);

        let recovered = contract
            .get_escrow("reconcile-failure".to_string())
            .unwrap();
        assert_eq!(recovered.status, EscrowStatus::Approved);
        assert_eq!(recovered.release_attempt, 1);
        assert_eq!(recovered.reconciliation_first_approver, None);
        assert_eq!(contract.get_total_locked().0, 25);
        assert_eq!(contract.get_spent_total().0, 0);

        set_context(accounts(3), 0);
        let _second_promise = contract.release("reconcile-failure".to_string());

        let second_attempt = contract
            .get_escrow("reconcile-failure".to_string())
            .unwrap();
        assert_eq!(second_attempt.status, EscrowStatus::Releasing);
        assert_eq!(second_attempt.release_attempt, 2);
        assert_eq!(second_attempt.reconciliation_first_approver, None);
    }

    #[test]
    #[should_panic(expected = "ERR_DUPLICATE_APPROVER")]
    fn reconciliation_same_account_cannot_vote_twice() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-duplicate", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-duplicate".to_string());

        let evidence = "d".repeat(64);

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-duplicate".to_string(), 1, true, evidence.clone());

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-duplicate".to_string(), 1, true, evidence);
    }

    #[test]
    #[should_panic(expected = "ERR_RECONCILIATION_CONFLICT")]
    fn reconciliation_rejects_different_outcomes() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-conflict", 25);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(4), true);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-conflict".to_string());

        let evidence = "e".repeat(64);

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-conflict".to_string(), 1, true, evidence.clone());

        set_context(accounts(4), 0);
        contract.reconcile_release("reconcile-conflict".to_string(), 1, false, evidence);
    }

    #[test]
    #[should_panic(expected = "ERR_EVIDENCE_MISMATCH")]
    fn reconciliation_rejects_different_evidence_hashes() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-hash-mismatch", 25);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(4), true);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-hash-mismatch".to_string());

        set_context(accounts(3), 0);
        contract.reconcile_release(
            "reconcile-hash-mismatch".to_string(),
            1,
            true,
            "a".repeat(64),
        );

        set_context(accounts(4), 0);
        contract.reconcile_release(
            "reconcile-hash-mismatch".to_string(),
            1,
            true,
            "b".repeat(64),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn reconciliation_rejects_second_vote_after_first_approver_revoked() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-revoked", 25);

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(4), true);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-revoked".to_string());

        set_context(accounts(3), 0);
        contract.reconcile_release("reconcile-revoked".to_string(), 1, true, "f".repeat(64));

        set_context(accounts(0), 0);
        contract.set_finance_approver(accounts(3), false);

        set_context(accounts(4), 0);
        contract.reconcile_release("reconcile-revoked".to_string(), 1, true, "f".repeat(64));
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn reconciliation_rejects_unauthorized_account() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-unauthorized", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-unauthorized".to_string());

        set_context(accounts(2), 0);
        contract.reconcile_release(
            "reconcile-unauthorized".to_string(),
            1,
            true,
            "1".repeat(64),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_SELF_APPROVAL")]
    fn reconciliation_rejects_order_payer() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-payer", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-payer".to_string());

        // The owner created this order and cannot reconcile their own order.
        set_context(accounts(0), 0);
        contract.reconcile_release("reconcile-payer".to_string(), 1, true, "2".repeat(64));
    }

    #[test]
    fn stale_callback_cannot_change_a_new_release_attempt() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "stale-callback", 25);

        set_context(accounts(3), 0);
        let _first_promise = contract.release("stale-callback".to_string());

        // Simulate the first transfer callback reporting failure.
        set_context(accounts(5), 0);
        contract.on_release_complete("stale-callback".to_string(), 1, Err(PromiseError::Failed));

        assert_eq!(
            contract
                .get_escrow("stale-callback".to_string())
                .unwrap()
                .status,
            EscrowStatus::Approved
        );

        // A second attempt is now in progress.
        set_context(accounts(3), 0);
        let _second_promise = contract.release("stale-callback".to_string());

        // A delayed callback from attempt 1 must not settle attempt 2.
        set_context(accounts(5), 0);
        contract.on_release_complete("stale-callback".to_string(), 1, Ok(()));

        let escrow = contract.get_escrow("stale-callback".to_string()).unwrap();
        assert_eq!(escrow.status, EscrowStatus::Releasing);
        assert_eq!(escrow.release_attempt, 2);
        assert_eq!(contract.get_total_locked().0, 25);
        assert_eq!(contract.get_spent_total().0, 0);
    }

    #[test]
    #[should_panic(expected = "ERR_STATE")]
    fn releasing_order_cannot_be_refunded() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "releasing-refund", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("releasing-refund".to_string());

        set_context(accounts(3), 0);
        contract.refund("releasing-refund".to_string());
    }

    #[test]
    fn reconciliation_first_vote_checks_storage_collateral_after_write() {
        let mut contract = new_contract();
        create_approved_order(&mut contract, "reconcile-storage", 25);

        set_context(accounts(3), 0);
        let _promise = contract.release("reconcile-storage".to_string());

        // Give the contract only one yoctoNEAR of margin above
        // its current storage and treasury liabilities.
        set_context_with_one_yocto_margin(&contract, accounts(3), env::storage_usage());

        let storage_before = env::storage_usage();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.reconcile_release("reconcile-storage".to_string(), 1, true, "c".repeat(64));
        }));

        // The mocked storage environment does not emulate transaction rollback.
        // This verifies that the write happens before the collateral assertion.
        assert_storage_write_rejected(result, storage_before);

        let escrow = contract
            .get_escrow("reconcile-storage".to_string())
            .unwrap();

        // In this Rust unit-test harness the write can remain visible after
        // catch_unwind. NEAR Runtime transaction rollback is a separate
        // execution property and must not be inferred from this assertion.
        assert_eq!(escrow.reconciliation_first_approver, Some(accounts(3)));
        assert_eq!(escrow.reconciliation_outcome, Some(true));
        assert_eq!(escrow.reconciliation_evidence_hash, Some("c".repeat(64)));
        assert_eq!(escrow.status, EscrowStatus::Releasing);
    }

    #[test]
    fn refund_success_returns_funds_to_central_treasury() {
        let mut contract = new_contract();

        create_order(&mut contract, "refund-success", 25);

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);
        contract.refund("refund-success".to_string());

        let escrow = contract.get_escrow("refund-success".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Refunded);
        assert_eq!(contract.get_total_locked().0, 0);
        assert_eq!(contract.get_spent_total().0, 0);
        assert_eq!(contract.get_treasury_available().0, BUDGET);
        assert_eq!(contract.get_available_budget().0, BUDGET);
    }

    #[test]
    #[should_panic(expected = "ERR_STATE")]
    fn approved_order_cannot_be_refunded() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "refund-approved", 25);

        set_context(accounts(3), 0);
        contract.refund("refund-approved".to_string());
    }

    #[test]
    fn submitted_order_can_be_refunded_to_treasury() {
        let mut contract = new_contract();

        create_order(&mut contract, "refund-submitted", 25);

        set_context(accounts(1), 0);
        contract.submit_delivery("refund-submitted".to_string(), "b".repeat(64));

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);
        contract.refund("refund-submitted".to_string());

        let escrow = contract.get_escrow("refund-submitted".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Refunded);
        assert_eq!(contract.get_total_locked().0, 0);
        assert_eq!(contract.get_treasury_available().0, BUDGET);
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn unauthorized_account_cannot_release() {
        let mut contract = new_contract();

        create_approved_order(&mut contract, "unauthorized-release", 25);

        set_context(accounts(2), 0);
        let _promise = contract.release("unauthorized-release".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_FINANCE_AUTH")]
    fn unauthorized_account_cannot_refund() {
        let mut contract = new_contract();

        create_order(&mut contract, "unauthorized-refund", 25);

        set_context(accounts(2), 0);
        contract.refund("unauthorized-refund".to_string());
    }

    #[test]
    fn refund_is_available_while_contract_is_paused() {
        let mut contract = new_contract();

        create_order(&mut contract, "paused-refund", 25);

        set_context(accounts(0), 0);
        contract.set_paused(true);

        authorize_finance(&mut contract);
        set_context(accounts(3), 0);
        contract.refund("paused-refund".to_string());

        let escrow = contract.get_escrow("paused-refund".to_string()).unwrap();

        assert_eq!(escrow.status, EscrowStatus::Refunded);
        assert_eq!(contract.get_total_locked().0, 0);
        assert_eq!(contract.get_treasury_available().0, BUDGET);
        assert!(contract.get_paused());
    }

    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const DEFAULT_TEST_STORAGE: u64 = 307_200;

    #[test]
    fn storage_reserve_uses_locked_balance_only_as_collateral() {
        let contract = new_unfunded_contract();

        set_context_with_balances(accounts(0), 0, 0, ONE_NEAR, 100);

        let required = 100u128 * 10_000_000_000_000_000_000u128;
        assert_eq!(contract.storage_liquid_reserve(), 0);

        set_context_with_balances(accounts(0), 0, 0, 0, 100);

        assert_eq!(contract.storage_liquid_reserve(), required);
    }

    #[test]
    fn deposit_repairs_storage_deficit_before_treasury_credit() {
        let mut contract = new_unfunded_contract();

        set_context_with_balances(accounts(0), 3 * ONE_NEAR, ONE_NEAR, 0, DEFAULT_TEST_STORAGE);

        contract.deposit();

        // 307,200 bytes * 0.00001 NEAR = 3.072 NEAR.
        // Existing balance is 1 NEAR, so 2.072 NEAR repairs the deficit.
        // Only the remaining 0.928 NEAR enters the treasury.
        assert_eq!(contract.treasury_available, 928_000_000_000_000_000_000_000);
    }

    #[test]
    fn partial_deposit_is_not_credited_to_treasury_while_deficit_remains() {
        let mut contract = new_unfunded_contract();

        set_context_with_balances(accounts(0), ONE_NEAR, ONE_NEAR, 0, DEFAULT_TEST_STORAGE);

        contract.deposit();

        assert_eq!(contract.treasury_available, 0);
    }

    #[test]
    fn agent_storage_growth_requires_collateral() {
        let mut contract = new_unfunded_contract();

        set_context_with_one_yocto_margin(&contract, accounts(0), DEFAULT_TEST_STORAGE);
        let storage_before = env::storage_usage();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.set_agent(accounts(1), true, U128(10));
        }));

        assert_storage_write_rejected(result, storage_before);
    }

    #[test]
    fn finance_approver_storage_growth_requires_collateral() {
        let mut contract = new_unfunded_contract();

        set_context_with_one_yocto_margin(&contract, accounts(0), DEFAULT_TEST_STORAGE);
        let storage_before = env::storage_usage();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.set_finance_approver(accounts(3), true);
        }));

        assert_storage_write_rejected(result, storage_before);
    }

    #[test]
    fn new_escrow_storage_growth_requires_collateral() {
        let mut contract = new_contract();

        set_context_with_one_yocto_margin(&contract, accounts(0), DEFAULT_TEST_STORAGE);
        let storage_before = env::storage_usage();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.create_escrow(
                "storage-underfunded-order".to_string(),
                accounts(1),
                U128(10),
            );
        }));

        assert_storage_write_rejected(result, storage_before);
    }

    #[test]
    fn delivery_hash_storage_growth_requires_collateral() {
        let mut contract = new_contract();
        create_order(&mut contract, "storage-hash-order", 10);

        // Use the actual storage usage after the escrow has been created.
        let storage_before_delivery = env::storage_usage();

        set_context_with_one_yocto_margin(&contract, accounts(1), storage_before_delivery);
        let storage_before = env::storage_usage();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.submit_delivery("storage-hash-order".to_string(), "a".repeat(64));
        }));

        assert_storage_write_rejected(result, storage_before);
    }
}
