// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title  TradeEscrow — 一对一直购担保合约
 * @notice 买家下单后把货款打进合约托管，确认收货后合约把货款结算给卖家（扣平台服务费），
 *         未确认前任一方可发起争议，由仲裁员裁决退款或放款。
 *
 * 状态码：
 *   0 托管中   —— 货款已在合约里，等待买家确认收货或发起争议
 *   1 已完成   —— 货款已结算给卖家（服务费另计）
 *   2 争议中   —— 有未裁决的争议，资金冻结
 *   3 已取消   —— 卖家发货前买家取消，货款原路退回
 *   4 已裁决   —— 仲裁完成，按裁决结果分配完毕
 */
contract TradeEscrow {
    struct Trade {
        uint256 orderId;      // 后端交易单号（与 MySQL 一一对应）
        address payable buyer;
        address payable seller;
        uint256 amount;       // 托管金额（wei）
        uint256 status;       // 0-4
        uint256 createdAt;
        string itemHash;      // 商品信息摘要，用于存证
        string disputeReason;
    }

    mapping(uint256 => Trade) public trades;      // 交易单号 => 交易
    mapping(uint256 => bool) public exists;       // 交易单号是否已创建

    address public admin;                          // 管理员（部署者）
    address public arbitrator;                     // 仲裁员
    uint16 public feeBps = 100;                    // 服务费，基点（100 = 1%）
    uint256 public accruedFees;                    // 待提取的服务费

    event TradeCreated(uint256 indexed orderId, address buyer, address seller, uint256 amount, string itemHash);
    event TradeCompleted(uint256 indexed orderId, address seller, uint256 payout, uint256 fee);
    event TradeCancelled(uint256 indexed orderId, address buyer, uint256 refund);
    event DisputeOpened(uint256 indexed orderId, address initiator, string reason);
    event DisputeResolved(uint256 indexed orderId, bool sellerWins, uint256 payout, uint256 refundToBuyer);
    event ArbitratorSet(address indexed arbitrator);
    event FeeUpdated(uint16 feeBps);

    modifier onlyAdminOrArbitrator() {
        require(msg.sender == admin || msg.sender == arbitrator, "Not authorized");
        _;
    }

    constructor() {
        admin = msg.sender;
        arbitrator = msg.sender;
    }

    function setArbitrator(address _arbitrator) external {
        require(msg.sender == admin, "Not admin");
        require(_arbitrator != address(0), "Zero address");
        arbitrator = _arbitrator;
        emit ArbitratorSet(_arbitrator);
    }

    function setFeeBps(uint16 _feeBps) external {
        require(msg.sender == admin, "Not admin");
        require(_feeBps <= 500, "Fee too high"); // 上限 5%
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    /**
     * @notice 买家下单，同时把货款转入合约托管
     * @param orderId  后端交易单号（不可重复）
     * @param seller   卖家地址
     * @param itemHash 商品信息摘要（后端生成）
     */
    function createTrade(uint256 orderId, address payable seller, string calldata itemHash) external payable {
        require(!exists[orderId], "Order exists");
        require(seller != address(0), "Bad seller");
        require(seller != msg.sender, "Cannot buy from self");
        require(msg.value > 0, "No funds");

        exists[orderId] = true;
        trades[orderId] = Trade({
            orderId: orderId,
            buyer: payable(msg.sender),
            seller: seller,
            amount: msg.value,
            status: 0,
            createdAt: block.timestamp,
            itemHash: itemHash,
            disputeReason: ""
        });

        emit TradeCreated(orderId, msg.sender, seller, msg.value, itemHash);
    }

    /**
     * @notice 买家确认收货：货款结算给卖家，扣除服务费
     */
    function confirmReceipt(uint256 orderId) external {
        Trade storage t = trades[orderId];
        require(exists[orderId], "Order missing");
        require(msg.sender == t.buyer, "Only buyer");
        require(t.status == 0, "Bad status");

        uint256 fee = (t.amount * feeBps) / 10000;
        uint256 payout = t.amount - fee;

        t.status = 1;
        accruedFees += fee;
        _safeTransfer(t.seller, payout);

        emit TradeCompleted(orderId, t.seller, payout, fee);
    }

    /**
     * @notice 卖家发货前，买家可取消并全额退回
     */
    function cancelTrade(uint256 orderId) external {
        Trade storage t = trades[orderId];
        require(exists[orderId], "Order missing");
        require(msg.sender == t.buyer, "Only buyer");
        require(t.status == 0, "Bad status");

        t.status = 3;
        _safeTransfer(t.buyer, t.amount);
        emit TradeCancelled(orderId, t.buyer, t.amount);
    }

    /**
     * @notice 买/卖任一方发起争议，资金冻结等待裁决
     */
    function openDispute(uint256 orderId, string calldata reason) external {
        Trade storage t = trades[orderId];
        require(exists[orderId], "Order missing");
        require(msg.sender == t.buyer || msg.sender == t.seller, "Not participant");
        require(t.status == 0, "Bad status");

        t.status = 2;
        t.disputeReason = reason;
        emit DisputeOpened(orderId, msg.sender, reason);
    }

    /**
     * @notice 仲裁裁决：把冻结货款在买卖双方之间分配
     * @param sellerWins    裁决结论（卖家是否胜诉），仅用于事件记录，资金按下方金额分配
     * @param refundToBuyer 退给买家的金额（wei），剩余部分扣除服务费后给卖家
     */
    function resolveDispute(uint256 orderId, bool sellerWins, uint256 refundToBuyer) external onlyAdminOrArbitrator {
        Trade storage t = trades[orderId];
        require(exists[orderId], "Order missing");
        require(t.status == 2, "Not disputed");
        require(refundToBuyer <= t.amount, "Refund too large");

        t.status = 4;

        if (refundToBuyer > 0) {
            _safeTransfer(t.buyer, refundToBuyer);
        }

        uint256 remain = t.amount - refundToBuyer;
        uint256 fee = (remain * feeBps) / 10000;
        uint256 payout = remain - fee;
        if (payout > 0) {
            accruedFees += fee;
            _safeTransfer(t.seller, payout);
        }

        emit DisputeResolved(orderId, sellerWins, payout, refundToBuyer);
    }

    /// @notice 管理员提取累计服务费
    function withdrawFees() external {
        require(msg.sender == admin, "Not admin");
        uint256 amount = accruedFees;
        require(amount > 0, "Nothing to withdraw");
        accruedFees = 0;
        _safeTransfer(payable(admin), amount);
    }

    /**
     * @notice 查询交易详情（后端对账使用）
     */
    function getTrade(uint256 orderId) external view returns (
        address buyer,
        address seller,
        uint256 amount,
        uint256 status,
        uint256 createdAt,
        string memory itemHash
    ) {
        require(exists[orderId], "Order missing");
        Trade storage t = trades[orderId];
        return (t.buyer, t.seller, t.amount, t.status, t.createdAt, t.itemHash);
    }

    function _safeTransfer(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Transfer failed");
    }
}
