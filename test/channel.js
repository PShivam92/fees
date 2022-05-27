/* 
    This test is testing uni-directional, promise based payment channel implementation. 
    Smart-contract code can be found in `contracts/ChannelImplementation.sol`. 
*/ 
 
const {BN} = require('web3-utils') 
const { 
    topUpTokens, 
    topUpEthers, 
    setupDEX, 
    sleep 
} = require('./utils/index.js') 
const wallet = require('./utils/wallet.js') 
const { generatePromise, signExitRequest, constructPayload } = require('./utils/client.js') 
 
const MystToken = artifacts.require("TestMystToken") 
const TestChannelImplementation = artifacts.require("TestChannelImplementation") 
const TestImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const OneEther = web3.utils.toWei(new BN(1), 'ether') 
const Zero = new BN(0) 
 
contract('Channel Contract Implementation tests', ([txMaker, ...otherAccounts]) => { 
    const identity = wallet.generateAccount()     // Generate identity 
    const identityHash = identity.address         // identity hash = keccak(publicKey)[:20] 
    const Imaginovation = wallet.generateAccount()   // Generate Imaginovation operator wallet 
    let token, channel 
    before(async () => { 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        ImaginovationImplementation = await TestImaginovationImplementation.new() 
        await ImaginovationImplementation.initialize(token.address, Imaginovation.address, 0, 0, OneToken, dex.address) 
        channel = await TestChannelImplementation.new(token.address, dex.address, identityHash, ImaginovationImplementation.address, Zero) 
 
        // Give some ethers for gas for Imaginovation 
        topUpEthers(txMaker, Imaginovation.address, OneEther) 
    }) 
 
    it("already initialized channel should reject initialization request", async () => { 
        expect(await channel.isInitialized()).to.be.true 
        await channel.initialize(token.address, otherAccounts[3], identityHash, Imaginovation.address).should.be.rejected 
    }) 
 
    /** 
     * Testing promise settlement functionality 
     */ 
 
    it("should be able to topup channel", async () => { 
        const userAccount = otherAccounts[0] 
        const amount = OneToken.mul(new BN(8)) // 8 full tokens 
        await topUpTokens(token, userAccount, amount) 
 
        await token.transfer(channel.address, amount, { from: userAccount }) 
        const channelTotalBalance = await token.balanceOf(channel.address) 
        channelTotalBalance.should.be.bignumber.equal(amount) 
    }) 
 
    it("should settle promise and send funds into beneficiary address", async () => { 
        const channelState = Object.assign({}, await channel.Imaginovation(), { channelId: channel.address }) 
        const amount = OneToken.mul(new BN(2)) // 2 full tokens 
        const channelBalanceBefore = await token.balanceOf(channel.address) 
 
        const promise = generatePromise(amount, new BN(0), channelState, identity) 
        await channel.settlePromise(promise.amount, promise.fee, promise.lock, promise.signature) 
 
        const channelBalanceAfter = await token.balanceOf(channel.address) 
        channelBalanceAfter.should.be.bignumber.equal(channelBalanceBefore.sub(amount)) 
 
        const ImaginovationTotalBalance = await token.balanceOf(channelState.contractAddress) 
        ImaginovationTotalBalance.should.be.bignumber.equal(promise.amount) 
    }) 
 
    it("should send given fee for transaction maker", async () => { 
        const channelState = Object.assign({}, await channel.Imaginovation(), { channelId: channel.address }) 
        const amount = OneToken.mul(new BN(2)) // 2 full tokens 
        const fee = OneToken.div(new BN(10)) // 0.1 tokens 
        const channelBalanceBefore = await token.balanceOf(channel.address) 
        const ImaginovationBalanceBefore = await token.balanceOf(channelState.contractAddress) 
 
        const promise = generatePromise(amount, fee, channelState, identity) 
        await channel.settlePromise(promise.amount, promise.fee, promise.lock, promise.signature) 
 
        const channelBalanceAfter = await token.balanceOf(channel.address) 
        channelBalanceAfter.should.be.bignumber.equal(channelBalanceBefore.sub(amount).sub(fee)) 
 
        const ImaginovationBalanceAfter = await token.balanceOf(channelState.contractAddress) 
        ImaginovationBalanceAfter.should.be.bignumber.equal(ImaginovationBalanceBefore.add(amount)) 
 
        const txMakerBalance = await token.balanceOf(txMaker) 
        txMakerBalance.should.be.bignumber.equal(fee) 
    }) 
 
    it("should not settle promise signed by wrong identity", async () => { 
        const fakeIdentity = wallet.generateAccount() 
        const channelState = Object.assign({}, await channel.Imaginovation(), { channelId: channel.address }) 
        const amount = OneToken.mul(new BN(2)) // 2 full tokens 
        const channelBalanceBefore = await token.balanceOf(channel.address) 
 
        const promise = generatePromise(amount, new BN(0), channelState, fakeIdentity) 
 
        // Promise signed by wrong identity have to be rejected 
        await channel.settlePromise( 
            promise.amount, 
            promise.fee, 
            promise.lock, 
            promise.signature 
        ).should.be.rejected 
 
        // Channel's balance should stay unchanged 
        const channelBalanceAfter = await token.balanceOf(channel.address) 
        channelBalanceAfter.should.be.bignumber.equal(channelBalanceBefore) 
    }) 
 
    it("self signed promise should be rejected", async () => { 
        const channelState = Object.assign({}, await channel.Imaginovation(), { channelId: channel.address }) 
 
        const promise = generatePromise(OneToken, new BN(0), channelState, Imaginovation, identityHash) 
 
        await wallet.sendTx(channel.address, constructPayload(promise), Imaginovation).should.be.rejected 
    }) 
 
    /** 
     * Testing topup with ETH via DEX 
     */ 
    it('should exchange ethers into tokens', async () => { 
        const userAccount = otherAccounts[0] 
        const initialChannelBalance = await token.balanceOf(channel.address) 
        const ethersAmount = new BN('2000') 
        const expectedTokens = new BN('3987') 
 
        // Send some ethers into payment channel 
        await channel.sendTransaction({ 
            from: userAccount, 
            value: ethersAmount, 
            gas: 20000000000 
        }) 
 
        const channelBalance = await token.balanceOf(channel.address) 
        channelBalance.should.be.bignumber.equal(initialChannelBalance.add(expectedTokens)) 
    }) 
}) 
