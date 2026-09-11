# AresRPG Bot - Complete Setup Summary

## ✅ What We Fixed

### 1. **Network Configuration Issues**
- **Problem**: Bot defaulted to testnet but characters are on mainnet
- **Solution**: Created `.env` with `SUI_NETWORK=mainnet`
- **Files**: `AresRPGBot/packages/bot/.env`

### 2. **Missing Mainnet Configuration**
- **Problem**: `pins.json` had empty mainnet section (all nulls)
- **Solution**: Fetched official mainnet pins from aresrpg/aresrpg repository
- **Files**: `AresRPGBot/pins.json`

### 3. **Session Expiration Handling**
- **Problem**: ZKLogin sessions expire and bot stops working
- **Solution**: 
  - Automatic session refresh on expiration
  - Discord notifications with clickable login link
  - Works from phone/anywhere
- **Files**: 
  - `src/shared/discord_notify.ts` (new)
  - `src/auth/enoki_auth.ts` (modified)
  - `src/cli/cli_group_session.ts` (modified)

### 4. **Discord Integration**
- **Problem**: No notifications for critical events
- **Solution**: Full Discord webhook integration
- **Features**:
  - Session start notifications
  - Session expiration alerts (with @mention)
  - Automatic login link generation
  - All notifications logged to console

## 📁 Repository Structure

**Two bot implementations exist:**
- **AresRPGBot** ✅ (RECOMMENDED - newer, better features)
- **AresRPG-RL** ❌ (older RL training version)

**Use `AresRPGBot` only.**

## ⚙️ Configuration Files

### `.env` Configuration
```bash
# Network
SUI_NETWORK=mainnet

# Discord Notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_HERE
DISCORD_MENTION=<@YOUR_USER_ID>

# Optional Limits
MAX_CONSECUTIVE_LOSSES=5
MAX_SESSION_GAS_SUI=1.0
```

## 🔄 Bot Loop Behavior

### Main Loop Flow:
1. **Initialization**
   - Load Enoki session (or request login via Discord)
   - Send session start notification
   - Load position from state file

2. **Every Fight** (repeats until max_fights or stopped):
   - Check daily dungeon quest (every 6h)
   - Ensure minimum balance (auto-claim from faucet)
   - Search zone → Engage → Fight → Settle
   - Auto-sell spare loot
   - Log results to `session.jsonl`
   - Wait 5s before next fight

3. **Error Handling**:
   - **Too Many Requests**: Retry after 30s
   - **No Targets in Zone**: Retry after 10min (zones refresh every 2h)
   - **ZKLogin Expired**: 
     - Send Discord notification with login link
     - Wait for user to authenticate
     - Automatically continue when logged in
   - **Insufficient Balance**: Wait for faucet cooldown

4. **Circuit Breakers**:
   - **5 consecutive losses** → Stop (prevents bad matchup gas drain)
   - **1 SUI total gas spent** → Stop (spending limit)

5. **State Persistence**:
   - Position saved after each fight
   - Session log appended continuously
   - Resumable on restart

## 🎮 How to Run

### Start Bot:
```bash
cd C:\Users\Mattheo\Desktop\Dev\GitRepository\AresrpgAuto\AresRPGBot\packages\bot
bun run session
```

### Manual Login (if needed):
```bash
bun run enoki-login
```

### Check Character Stats:
```bash
bun run characters
```

### View Session Stats:
```bash
bun run session-stats
```

## 🐳 Docker Support

### Build:
```bash
cd C:\Users\Mattheo\Desktop\Dev\GitRepository\AresrpgAuto\AresRPGBot
docker build -t aresrpg-bot .
```

### Run:
```bash
docker run -d --name aresrpg-bot aresrpg-bot
```

### View Logs:
```bash
docker logs -f aresrpg-bot
```

## 📱 Mobile Authentication

When session expires:
1. **Discord notification** sent with login link and @mention
2. **Click link** from your phone
3. **Sign in** with Google (same account as aresrpg.world)
4. **Bot automatically continues** farming

No need to access the server - works from anywhere!

## 🔧 Known Issues & Solutions

### Issue: "Too Many Requests"
- **Cause**: Public RPC rate limiting
- **Solution**: Normal behavior, bot retries automatically
- **Optional**: Use paid RPC provider (but requires gRPC-Web support)

### Issue: "Not Found" from Ankr RPC
- **Cause**: Ankr doesn't support gRPC-Web format
- **Solution**: Use default Sui RPC (already configured)

### Issue: Session expires frequently
- **Cause**: ZKLogin tied to Sui epochs (~1 day)
- **Solution**: Automatic re-auth via Discord link (implemented ✅)

## 📊 Current Status

### Characters (Mainnet):
- **omori** - Mori, Level 11 (Leader)
- **memorien** - Mori, Level 11
- **llokan** - Yogan, Level 11
- **archero** - Yogan, Level 11

### Wallet:
- Address: `0xc15b7fe590c5bfc346a42b16a957d57a5119b2ba5d2658393894b51f6cb74646`
- Balance: ~14.98 SUI
- Kiosk: All characters in personal kiosk

### Bot Capabilities:
- ✅ Group fights (4 characters)
- ✅ Automatic zone discovery/refresh
- ✅ Daily dungeon quests
- ✅ Auto-faucet claiming
- ✅ Auto-sell spare loot
- ✅ Discord notifications
- ✅ Session persistence
- ✅ Gas tracking
- ✅ Profit calculation

## 🎯 Farming Objective

**Goal**: Farm fights, resources, and dungeons automatically

**Current Strategy**:
- Fight groups in zone (94,97) at position (48387,50113)
- Trained combat policy (fitness 113.43)
- Auto-sells spare loot for SUI
- Checks daily dungeon quest every 6h
- Stops if too many losses or gas cap reached

## ✨ Next Steps

1. **Start the bot** with `bun run session`
2. **Monitor Discord** for notifications
3. **Check session-stats** periodically
4. **Adjust .env limits** if needed (MAX_SESSION_GAS_SUI, etc.)

---

**Bot is fully operational and ready to farm! 🎮**
