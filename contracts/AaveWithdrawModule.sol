// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISafe {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
}

interface IAavePool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @title AaveWithdrawModule
/// @notice Withdraw-only Safe module. Pulls `amount` of a fixed `asset` from a
///         fixed Aave `pool` into the owning `safe`, executed AS the Safe (so the
///         Safe's own aTokens are burned). Designed as the target of a CoW
///         per-part pre-hook: at settlement the HooksTrampoline (untrusted) is
///         `msg.sender`, so a naive `AavePool.withdraw` from the trampoline would
///         fail (it holds no aTokens). Routing through this module lets the Safe
///         do the withdraw without ever approving an arbitrary puller.
///
///         Callable by ANYONE — and that is safe by construction: funds can only
///         ever land in `safe`, and only `asset` is ever touched. There is no
///         transfer/approve-to-arbitrary path (yield-leg withdraw-only). The worst
///         a caller can do is force idle yield back into the Safe (griefing, not
///         theft). A per-call/per-epoch amount cap is layered on in M3.
contract AaveWithdrawModule {
    address public immutable safe;
    address public immutable pool;
    address public immutable asset;
    /// @notice Per-call withdrawal cap (yield-leg envelope bound). A single
    ///         withdrawPart call may not pull more than this — bounds what any
    ///         (untrusted) caller can move per call. Set to one part's amount.
    uint256 public immutable maxWithdrawPerCall;

    error WithdrawFailed();
    error AmountExceedsCap();

    constructor(address _safe, address _pool, address _asset, uint256 _maxWithdrawPerCall) {
        safe = _safe;
        pool = _pool;
        asset = _asset;
        maxWithdrawPerCall = _maxWithdrawPerCall;
    }

    /// @notice Withdraw exactly `amount` of `asset` from Aave into the Safe.
    function withdrawPart(uint256 amount) external {
        if (amount > maxWithdrawPerCall) revert AmountExceedsCap();
        bytes memory data = abi.encodeWithSelector(IAavePool.withdraw.selector, asset, amount, safe);
        bool ok = ISafe(safe).execTransactionFromModule(pool, 0, data, 0);
        if (!ok) revert WithdrawFailed();
    }
}
