// SPDX-License-Identifier: GPL-3.0 
pragma solidity 0.8.9; 
 
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol"; 
import { IUniswapV2Router } from "./interfaces/IUniswapV2Router.sol"; 
import { IERC20Token } from "./interfaces/IERC20Token.sol"; 
import { FundsRecovery } from "./FundsRecovery.sol"; 
import { Utils } from "./Utils.sol"; 
 
interface IdentityRegistry { 
    function isRegistered(address _identity) external view returns (bool); 
    function minimalImaginovationStake() external view returns (uint256); 
    function getChannelAddress(address _identity, address _hermesId) external view returns (address); 
    function getBeneficiary(address _identity) external view returns (address); 
    function setBeneficiary(address _identity, address _newBeneficiary, bytes memory _signature) external; 
} 
 
contract ImaginovationImplementation is FundsRecovery, Utils { 
    using ECDSA for bytes32; 
 
    string constant STAKE_RETURN_PREFIX = "Stake return request"; 
    uint256 constant DELAY_SECONDS = 259200;   // 3 days 
    uint256 constant UNIT_SECONDS = 3600;      // 1 unit = 1 hour = 3600 seconds 
    uint16 constant PUNISHMENT_PERCENT = 4;    // 0.04% 
 
    IdentityRegistry internal registry; 
    address internal operator;                 // TODO have master operator who could change operator or manage funds 
 
    uint256 internal totalStake;               // total amount staked by providers 
 
    uint256 internal minStake;                 // minimal possible provider's stake (channel opening during promise settlement will use it) 
    uint256 internal maxStake;                 // maximal allowed provider's stake 
    uint256 internal hermesStake;              // Imaginovation stake is used to prove Imaginovation' sustainability 
    uint256 internal closingTimelock;          // blocknumber after which getting stake back will become possible 
    IUniswapV2Router internal dex;             // any uniswap v2 compatible dex router address 
 
    enum Status { Active, Paused, Punishment, Closed } // Imaginovation states 
    Status internal status; 
 
    struct ImaginovationFee { 
        uint16 value;                      // subprocent amount. e.g. 0.729 
        uint64 validFrom;                  // timestamp from which fee is valid 
    } 
    ImaginovationFee public lastFee;              // default fee to look for 
    ImaginovationFee public previousFee;          // previous fee is used if last fee is still not active 
 
     
    struct Channel { 
        uint256 settled;                   // total amount already settled by provider 
        uint256 stake;                     // amount staked by identity to guarante channel size, it also serves as channel balance 
        uint256 lastUsedNonce;             // last known nonce, is used to protect signature based calls from replay attack 
        uint256 timelock;                  // blocknumber after which channel balance can be decreased 
    } 
    mapping(bytes32 => Channel) public channels; 
 
    struct Punishment { 
        uint256 activationBlockTime;       // block timestamp in which punishment was activated 
        uint256 amount;                    // total amount of tokens locked because of punishment 
    } 
    Punishment public punishment; 
 
    function getOperator() public view returns (address) { 
        return operator; 
    } 
 
    function getChannelId(address _identity) public view returns (bytes32) { 
        return keccak256(abi.encodePacked(_identity, address(this))); 
    } 
 
    function getChannelId(address _identity, string memory _type) public view returns (bytes32) { 
        return keccak256(abi.encodePacked(_identity, address(this), _type)); 
    } 
 
    function getRegistry() public view returns (address) { 
        return address(registry); 
    } 
 
    function getActiveFee() public view returns (uint256) { 
        ImaginovationFee memory _activeFee = (block.timestamp >= lastFee.validFrom) ? lastFee : previousFee; 
        return uint256(_activeFee.value); 
    } 
 
    function getImaginovationStake() public view returns (uint256) { 
        return hermesStake; 
    } 
 
    function getStakeThresholds() public view returns (uint256, uint256) { 
        return (minStake, maxStake); 
    } 
 
    // Returns Imaginovation state 
    // Active - all operations are allowed. 
    // Paused - no new channel openings. 
    // Punishment - don't allow to open new channels, rebalance and withdraw funds. 
    // Closed - no new channels, no rebalance, no stake increase. 
    function getStatus() public view returns (Status) { 
        return status; 
    } 
 
    event PromiseSettled(address indexed identity, bytes32 indexed channelId, address indexed beneficiary, uint256 amountSentToBeneficiary, uint256 fees, bytes32 lock); 
    event NewStake(bytes32 indexed channelId, uint256 stakeAmount); 
    event MinStakeValueUpdated(uint256 newMinStake); 
    event MaxStakeValueUpdated(uint256 newMaxStake); 
    event ImaginovationFeeUpdated(uint16 newFee, uint64 validFrom); 
    event ImaginovationClosed(uint256 blockTimestamp); 
    event ChannelOpeningPaused(); 
    event ChannelOpeningActivated(); 
    event FundsWithdrawned(uint256 amount, address beneficiary); 
    event ImaginovationStakeIncreased(uint256 newStake); 
    event ImaginovationPunishmentActivated(uint256 activationBlockTime); 
    event ImaginovationPunishmentDeactivated(); 
    event ImaginovationStakeReturned(address beneficiary); 
 
    /* 
      ------------------------------------------- SETUP ------------------------------------------- 
    */ 
 
    // Because of proxy pattern this function is used insted of constructor. 
    // Have to be called right after proxy deployment. 
    function initialize(address _token, address _operator, uint16 _fee, uint256 _minStake, uint256 _maxStake, address payable _dexAddress) public virtual { 
        require(!isInitialized(), "Imaginovation: have to be not initialized"); 
        require(_token != address(0), "Imaginovation: token can't be deployd into zero address"); 
        require(_operator != address(0), "Imaginovation: operator have to be set"); 
        require(_fee <= 5000, "Imaginovation: fee can't be bigger than 50%"); 
        require(_maxStake > _minStake, "Imaginovation: maxStake have to be bigger than minStake"); 
 
        registry = IdentityRegistry(msg.sender); 
        token = IERC20Token(_token); 
        operator = _operator; 
        lastFee = ImaginovationFee(_fee, uint64(block.timestamp)); 
        minStake = _minStake; 
        maxStake = _maxStake; 
        hermesStake = token.balanceOf(address(this)); 
 
        // Approving all myst for dex, because MYST token's `transferFrom` is cheaper when there is approval of uint(-1) 
        token.approve(_dexAddress, type(uint256).max); 
        dex = IUniswapV2Router(_dexAddress); 
 
        transferOwnership(_operator); 
    } 
 
    function isInitialized() public view returns (bool) { 
        return operator != address(0); 
    } 
 
    /* 
      -------------------------------------- MAIN FUNCTIONALITY ----------------------------------- 
    */ 
 
    // Open incoming payments (also known as provider) channel. Can be called only by Registry. 
    function openChannel(address _identity, uint256 _amountToStake) public { 
        require(msg.sender == address(registry), "Imaginovation: only registry can open channels"); 
        require(getStatus() == Status.Active, "Imaginovation: have to be in active state"); 
        require(_amountToStake >= minStake, "Imaginovation: min stake amount not reached"); 
        _increaseStake(getChannelId(_identity), _amountToStake, false); 
    } 
 
    // Settle promise 
    // _preimage is random number generated by receiver used in HTLC 
    function _settlePromise( 
        bytes32 _channelId, 
        uint256 _amount, 
        uint256 _transactorFee, 
        bytes32 _preimage, 
        bytes memory _signature, 
        bool _takeFee, 
        bool _ignoreStake 
    ) private returns (uint256, uint256) { 
        require( 
            isImaginovationActive(), 
            "Imaginovation: Imaginovation have to be in active state" 
        ); // if Imaginovation is not active, then users can only take stake back 
        require( 
            validatePromise(_channelId, _amount, _transactorFee, _preimage, _signature), 
            "Imaginovation: have to be properly signed payment promise" 
        ); 
 
        Channel storage _channel = channels[_channelId]; 
        require(_channel.settled > 0 || _channel.stake >= minStake || _ignoreStake, "Imaginovation: not enough stake"); 
 
        // If there are not enough funds to rebalance we have to enable punishment mode. 
        uint256 _availableBalance = availableBalance(); 
        if (_availableBalance < _channel.stake) { 
            status = Status.Punishment; 
            punishment.activationBlockTime = block.timestamp; 
            emit ImaginovationPunishmentActivated(block.timestamp); 
        } 
 
        // Calculate amount of tokens to be claimed. 
        uint256 _unpaidAmount = _amount - _channel.settled; 
        require(_unpaidAmount > _transactorFee, "Imaginovation: amount to settle should cover transactor fee"); 
 
        // It is not allowed to settle more than maxStake / _channel.stake and than available balance. 
        uint256 _maxSettlementAmount = max(maxStake, _channel.stake); 
        if (_unpaidAmount > _availableBalance || _unpaidAmount > _maxSettlementAmount) { 
               _unpaidAmount = min(_availableBalance, _maxSettlementAmount); 
        } 
 
        _channel.settled = _channel.settled + _unpaidAmount; // Increase already paid amount. 
        uint256 _fees = _transactorFee + (_takeFee ? calculateImaginovationFee(_unpaidAmount) : 0); 
 
        // Pay transactor fee 
        if (_transactorFee > 0) { 
            token.transfer(msg.sender, _transactorFee); 
        } 
 
        uint256 _amountToTransfer = _unpaidAmount -_fees; 
 
        return (_amountToTransfer, _fees); 
    } 
 
    function settlePromise(address _identity, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _signature) public { 
        address _beneficiary = registry.getBeneficiary(_identity); 
        require(_beneficiary != address(0), "Imaginovation: identity have to be registered, beneficiary have to be set"); 
 
        // Settle promise and transfer calculated amount into beneficiary wallet 
        bytes32 _channelId = getChannelId(_identity); 
        (uint256 _amountToTransfer, uint256 _fees) = _settlePromise(_channelId, _amount, _transactorFee, _preimage, _signature, true, false); 
        token.transfer(_beneficiary, _amountToTransfer); 
 
        emit PromiseSettled(_identity, _channelId, _beneficiary, _amountToTransfer, _fees, _preimage); 
    } 
 
    function payAndSettle(address _identity, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _signature, address _beneficiary, bytes memory _beneficiarySignature) public { 
        bytes32 _channelId = getChannelId(_identity, "withdrawal"); 
 
        // Validate beneficiary to be signed by identity and be attached to given promise 
        address _signer = keccak256(abi.encodePacked(getChainID(), _channelId, _amount, _preimage, _beneficiary)).recover(_beneficiarySignature); 
        require(_signer == _identity, "Imaginovation: payAndSettle request should be properly signed"); 
 
        (uint256 _amountToTransfer, uint256 _fees) = _settlePromise(_channelId, _amount, _transactorFee, _preimage, _signature, false, true); 
        token.transfer(_beneficiary, _amountToTransfer); 
 
        emit PromiseSettled(_identity, _channelId, _beneficiary, _amountToTransfer, _fees, _preimage); 
    } 
 
    function settleWithBeneficiary(address _identity, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _promiseSignature, address _newBeneficiary, bytes memory _beneficiarySignature) public { 
        // Update beneficiary address 
        registry.setBeneficiary(_identity, _newBeneficiary, _beneficiarySignature); 
 
        // Settle promise and transfer calculated amount into beneficiary wallet 
        bytes32 _channelId = getChannelId(_identity); 
        (uint256 _amountToTransfer, uint256 _fees) = _settlePromise(_channelId, _amount, _transactorFee, _preimage, _promiseSignature, true, false); 
        token.transfer(_newBeneficiary, _amountToTransfer); 
 
        emit PromiseSettled(_identity, _channelId, _newBeneficiary, _amountToTransfer, _fees, _preimage); 
    } 
 
    function settleWithDEX(address _identity, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _signature) public { 
        address _beneficiary = registry.getBeneficiary(_identity); 
        require(_beneficiary != address(0), "Imaginovation: identity have to be registered, beneficiary have to be set"); 
 
        // Calculate amount to transfer and settle promise 
        bytes32 _channelId = getChannelId(_identity); 
        (uint256 _amountToTransfer, uint256 _fees) = _settlePromise(_channelId, _amount, _transactorFee, _preimage, _signature, true, false); 
 
        // Transfer funds into beneficiary wallet via DEX 
        uint amountOutMin = 0; 
        address[] memory path = new address[](2); 
        path[0] = address(token); 
        path[1] = dex.WETH(); 
 
        dex.swapExactTokensForETH(_amountToTransfer, amountOutMin, path, _beneficiary, block.timestamp); 
 
        emit PromiseSettled(_identity, _channelId, _beneficiary, _amountToTransfer, _fees, _preimage); 
    } 
 
    /* 
      -------------------------------------- STAKE MANAGEMENT -------------------------------------- 
    */ 
 
    function _increaseStake(bytes32 _channelId, uint256 _amountToAdd, bool _duringSettlement) internal { 
        Channel storage _channel = channels[_channelId]; 
        uint256 _newStakeAmount = _channel.stake +_amountToAdd; 
        require(_newStakeAmount <= maxStake, "Imaginovation: total amount to stake can't be bigger than maximally allowed"); 
        require(_newStakeAmount >= minStake, "Imaginovation: stake can't be less than required min stake"); 
 
        // We don't transfer tokens during settlements, they already locked in Imaginovation contract. 
        if (!_duringSettlement) { 
            require(token.transferFrom(msg.sender, address(this), _amountToAdd), "Imaginovation: token transfer should succeed"); 
        } 
 
        _channel.stake = _newStakeAmount; 
        totalStake = totalStake + _amountToAdd; 
 
        emit NewStake(_channelId, _newStakeAmount); 
    } 
 
    // Anyone can increase channel's capacity by staking more into Imaginovation 
    function increaseStake(bytes32 _channelId, uint256 _amount) public { 
        require(getStatus() != Status.Closed, "Imaginovation: should be not closed"); 
        _increaseStake(_channelId, _amount, false); 
    } 
 
    // Settlement which will increase channel stake instead of transfering funds into beneficiary wallet. 
    function settleIntoStake(address _identity, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _signature) public { 
        bytes32 _channelId = getChannelId(_identity); 
        (uint256 _stakeIncreaseAmount, uint256 _paidFees) = _settlePromise(_channelId, _amount, _transactorFee, _preimage, _signature, true, true); 
        emit PromiseSettled(_identity, _channelId, address(this), _stakeIncreaseAmount, _paidFees, _preimage); 
        _increaseStake(_channelId, _stakeIncreaseAmount, true); 
    } 
 
    // Withdraw part of stake. This will also decrease channel balance. 
    function decreaseStake(address _identity, uint256 _amount, uint256 _transactorFee, bytes memory _signature) public { 
        bytes32 _channelId = getChannelId(_identity); 
        require(isChannelOpened(_channelId), "Imaginovation: channel has to be opened"); 
        require(_amount >= _transactorFee, "Imaginovation: amount should be bigger than transactor fee"); 
 
        Channel storage _channel = channels[_channelId]; 
        require(_amount <= _channel.stake, "Imaginovation: can't withdraw more than the current stake"); 
 
        // Verify signature 
        _channel.lastUsedNonce = _channel.lastUsedNonce + 1; 
        address _signer = keccak256(abi.encodePacked(STAKE_RETURN_PREFIX, getChainID(), _channelId, _amount, _transactorFee, _channel.lastUsedNonce)).recover(_signature); 
        require(getChannelId(_signer) == _channelId, "Imaginovation: have to be signed by channel party"); 
 
        uint256 _newStakeAmount = _channel.stake - _amount; 
        require(_newStakeAmount == 0 || _newStakeAmount >= minStake, "Imaginovation: stake can't be less than required min stake"); 
 
        // Update channel state 
        _channel.stake = _newStakeAmount; 
        totalStake = totalStake - _amount; 
 
        // Pay transactor fee then withdraw the rest 
        if (_transactorFee > 0) { 
            token.transfer(msg.sender, _transactorFee); 
        } 
 
        address _beneficiary = registry.getBeneficiary(_identity); 
        token.transfer(_beneficiary, _amount - _transactorFee); 
 
        emit NewStake(_channelId, _newStakeAmount); 
    } 
 
    /* 
      --------------------------------------------------------------------------------------------- 
    */ 
 
    // Imaginovation is in Emergency situation when its status is `Punishment`. 
    function resolveEmergency() public { 
        require(getStatus() == Status.Punishment, "Imaginovation: should be in punishment status"); 
 
        // No punishment during first time unit 
        uint256 _unit = getUnitTime(); 
        uint256 _timePassed = block.timestamp - punishment.activationBlockTime; 
        uint256 _punishmentUnits = round(_timePassed, _unit) / _unit - 1; 
 
        // Using 0.04% of total channels amount per time unit 
        uint256 _punishmentAmount = _punishmentUnits * round(totalStake * PUNISHMENT_PERCENT, 100) / 100; 
        punishment.amount = punishment.amount + _punishmentAmount;  // XXX alternativelly we could send tokens into BlackHole (0x0000000...) 
 
        uint256 _shouldHave = minimalExpectedBalance() + maxStake;  // Imaginovation should have funds for at least one maxStake settlement 
        uint256 _currentBalance = token.balanceOf(address(this)); 
 
        // If there are not enough available funds, they have to be topupped from msg.sender. 
        if (_currentBalance < _shouldHave) { 
            token.transferFrom(msg.sender, address(this), _shouldHave - _currentBalance); 
        } 
 
        // Disable punishment mode 
        status = Status.Active; 
 
        emit ImaginovationPunishmentDeactivated(); 
    } 
 
    function getUnitTime() internal pure virtual returns (uint256) { 
        return UNIT_SECONDS; 
    } 
 
    function setMinStake(uint256 _newMinStake) public onlyOwner { 
        require(isImaginovationActive(), "Imaginovation: has to be active"); 
        require(_newMinStake < maxStake, "Imaginovation: minStake has to be smaller than maxStake"); 
        minStake = _newMinStake; 
        emit MinStakeValueUpdated(_newMinStake); 
    } 
 
    function setMaxStake(uint256 _newMaxStake) public onlyOwner { 
        require(isImaginovationActive(), "Imaginovation: has to be active"); 
        require(_newMaxStake > minStake, "Imaginovation: maxStake has to be bigger than minStake"); 
        maxStake = _newMaxStake; 
        emit MaxStakeValueUpdated(_newMaxStake); 
    } 
 
    function setImaginovationFee(uint16 _newFee) public onlyOwner { 
        require(getStatus() != Status.Closed, "Imaginovation: should be not closed"); 
        require(_newFee <= 5000, "Imaginovation: fee can't be bigger than 50%"); 
        require(block.timestamp >= lastFee.validFrom, "Imaginovation: can't update inactive fee"); 
 
        // New fee will start be valid after delay time will pass 
        uint64 _validFrom = uint64(getTimelock()); 
 
        previousFee = lastFee; 
        lastFee = ImaginovationFee(_newFee, _validFrom); 
 
        emit ImaginovationFeeUpdated(_newFee, _validFrom); 
    } 
 
    function increaseImaginovationStake(uint256 _additionalStake) public onlyOwner { 
        if (availableBalance() < _additionalStake) { 
            uint256 _diff = _additionalStake - availableBalance(); 
            token.transferFrom(msg.sender, address(this), _diff); 
        } 
 
        hermesStake = hermesStake + _additionalStake; 
 
        emit ImaginovationStakeIncreased(hermesStake); 
    } 
 
    // Imaginovation's available funds withdrawal. Can be done only if Imaginovation is not closed and not in punishment mode. 
    // Imaginovation can't withdraw stake, locked in channel funds and funds lended to him. 
    function withdraw(address _beneficiary, uint256 _amount) public onlyOwner { 
        require(isImaginovationActive(), "Imaginovation: have to be active"); 
        require(availableBalance() >= _amount, "Imaginovation: should be enough funds available to withdraw"); 
 
        token.transfer(_beneficiary, _amount); 
 
        emit FundsWithdrawned(_amount, _beneficiary); 
    } 
 
    // Returns funds amount not locked in any channel, not staked and not lended from providers. 
    function availableBalance() public view returns (uint256) { 
        uint256 _totalLockedAmount = minimalExpectedBalance(); 
        uint256 _currentBalance = token.balanceOf(address(this)); 
        if (_totalLockedAmount > _currentBalance) { 
            return uint256(0); 
        } 
        return _currentBalance - _totalLockedAmount; 
    } 
 
    // Returns true if channel is opened. 
    function isChannelOpened(bytes32 _channelId) public view returns (bool) { 
        return channels[_channelId].settled != 0 || channels[_channelId].stake != 0; 
    } 
 
    // If Imaginovation is not closed and is not in punishment mode, he is active. 
    function isImaginovationActive() public view returns (bool) { 
        Status _status = getStatus(); 
        return _status != Status.Punishment && _status != Status.Closed; 
    } 
 
    function pauseChannelOpening() public onlyOwner { 
        require(getStatus() == Status.Active, "Imaginovation: have to be in active state"); 
        status = Status.Paused; 
        emit ChannelOpeningPaused(); 
    } 
 
    function activateChannelOpening() public onlyOwner { 
        require(getStatus() == Status.Paused, "Imaginovation: have to be in paused state"); 
        status = Status.Active; 
        emit ChannelOpeningActivated(); 
    } 
 
    function closeImaginovation() public onlyOwner { 
        require(isImaginovationActive(), "Imaginovation: should be active"); 
        status = Status.Closed; 
        closingTimelock = getEmergencyTimelock(); 
        emit ImaginovationClosed(block.timestamp); 
    } 
 
    function getStakeBack(address _beneficiary) public onlyOwner { 
        require(getStatus() == Status.Closed, "Imaginovation: have to be closed"); 
        require(block.timestamp > closingTimelock, "Imaginovation: timelock period should be already passed"); 
 
        uint256 _amount = token.balanceOf(address(this)) - punishment.amount; 
        token.transfer(_beneficiary, _amount); 
 
        emit ImaginovationStakeReturned(_beneficiary); 
    } 
 
    /* 
      ------------------------------------------ HELPERS ------------------------------------------ 
    */ 
    // Returns timestamp until which exit request should be locked 
    function getTimelock() internal view virtual returns (uint256) { 
        return block.timestamp + DELAY_SECONDS; 
    } 
 
    function calculateImaginovationFee(uint256 _amount) public view returns (uint256) { 
        return round((_amount * getActiveFee() / 100), 100) / 100; 
    } 
 
    // Funds which always have to be holded in Imaginovation smart contract. 
    function minimalExpectedBalance() public view returns (uint256) { 
        return max(hermesStake, punishment.amount) + totalStake; 
    } 
 
    function getEmergencyTimelock() internal view virtual returns (uint256) { 
        return block.timestamp + DELAY_SECONDS * 100; // 300 days 
    } 
 
    function validatePromise(bytes32 _channelId, uint256 _amount, uint256 _transactorFee, bytes32 _preimage, bytes memory _signature) public view returns (bool) { 
        bytes32 _hashlock = keccak256(abi.encodePacked(_preimage)); 
        address _signer = keccak256(abi.encodePacked(getChainID(), _channelId, _amount, _transactorFee, _hashlock)).recover(_signature); 
        return _signer == operator; 
    } 
} 
