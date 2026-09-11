# AresRPG Combat Bot Architecture Summary

## Overview
This system combines the reinforcement learning capabilities of AresRPG-RL (Python) with the live bot interaction capabilities of AresRPGBot (TypeScript/Bun) to create an autonomous combat bot that uses learned knowledge to make combat decisions.

## Architecture Components

### 1. RL Decision Service (Python)
- **Location**: `AresRPG-RL/rl/decide_service.py`
- **Function**: Provides combat decision making via stdin/stdout JSON protocol
- **Capabilities**:
  - Beam Search + Value Network for accurate decision making
  - Greedy policy scoring for fast decisions
  - Uses trained policy models (`models/policy.json`)
  - Uses trained value networks (`models/value_net.pt`) when available
- **Input**: JSON object containing fight state and decision parameters
- **Output**: JSON object containing best action, win probability, and alternatives

### 2. Fight Engine Bridge (TypeScript/Bun)
- **Location**: `AresRPG-RL/bridge/server.ts`
- **Function**: Contains the actual AresRPG fight engine and provides communication interface
- **Protocol**: JSON lines over stdin/stdout
- **Commands**:
  - `reset`: Initialize a new fight
  - `state`: Get current state and legal actions
  - `snapshot`/`restore`: Save and restore fight states for search
  - `step`: Execute an action and get the result
  - `decide`: Get the best action for current state using RL system (new)

### 3. Live Bot Integration (TypeScript)
- **Location**: `AresRPGBot/packages/bot/src/`
- **Components**:
  - `ai/tsbridge.ts`: TypeScript client for communicating with the fight engine bridge
  - `ai/rldecision.ts`: TypeScript client for communicating with the Python RL decision service
  - `fight/fight_turn.ts`: Modified to use RL system for combat decision making

## Data Flow

### During Combat:
1. **Observe**: Live bot reads current fight state from the game via `read_fight()`
2. **Represent**: Convert live fight state to format expected by RL system using `liveStateToBridgeState()`
3. **Decide**: 
   - Option A (Direct): Live bot → fight engine bridge → "decide" command → RL decision service → best action
   - Option B (Service): Live bot → RL decision service → best action
4. **Execute**: Live bot commits the decided action to the game via `fight.commit_turn()`
5. **Learn**: Observe result and repeat until fight ends

### Decision Making Options:
1. **Beam Search + Value Network** (Most accurate): Uses lookahead and value network to evaluate action sequences
2. **Greedy Policy Scoring** (Fastest): Uses policy network to score individual actions
3. **Fallback**: Original local policy scoring if RL system unavailable

## Key Files Modified/Added

### AresRPG-RL:
- `rl/decide.py`: Core decision making functions (Beam Search, greedy)
- `rl/decide_service.py`: stdin/stdout decision service wrapper
- `bridge/server.ts`: Added "decide" command handler

### AresRPGBot:
- `packages/bot/src/ai/tsbridge.ts`: TypeScript fight engine bridge client
- `packages/bot/src/ai/rldecision.ts`: TypeScript RL decision service client
- `packages/bot/src/fight/fight_turn.ts`: Modified to use RL decision making

## Usage

### Training the RL System (Unchanged):
```bash
# Train using evolutionary strategy
python -m rl.evolve --generations 8 --population 10 --scenarios 8

# Or use multi-run training for robustness against overfitting
python -m tools.multi_evolve --runs 4 --generations 8 --population 10 --scenarios 8
```

### Running the Autonomous Bot:
The modified live bot will automatically use the RL system for decision making when:
1. Trained policy exists at `AresRPG-RL/models/policy.json`
2. The fight engine bridge can be initialized
3. The RL decision service can be contacted

If the RL system is unavailable, the bot falls back to its original local policy scoring.

## Advantages of This Approach

1. **Leverages Existing Strengths**:
   - Python: Superior for RL algorithms (Beam Search, Value Network, evolution)
   - TypeScript: Superior for live game interaction and async operations

2. **Reuses Existing Code**:
   - No rewriting of core game logic
   - No rewriting of proven RL training pipeline
   - No rewriting of live bot infrastructure

3. **Maintainable Architecture**:
   - Clear separation of concerns
   - Well-defined interfaces between components
   - Easy to debug and test individual components

4. **Performance Characteristics**:
   - Beam Search provides lookahead capabilities for better decisions
   - Value Network provides state evaluation for accurate win probability estimation
   - Greedy mode available for low-latency requirements
   - Fallback ensures bot always remains functional

## Known Limitations

1. **Inter-process Communication Overhead**: 
   - Spawning processes for each decision adds latency
   - Mitigation: Reuse processes where possible, consider persistent connections

2. **State Conversion Complexity**:
   - Converting between live game state and RL state format requires careful mapping
   - Mitigation: Centralized conversion functions, thorough testing

3. **Resource Usage**:
   - Multiple processes running concurrently (fight engine, decision service)
   - Mitigation: Proper process cleanup, consider connection pooling

## Future Improvements

1. **Persistent Decision Service**: 
   - Keep Python decision service running as a persistent daemon
   - Reduce process spawning overhead

2. **Batching**:
   - Batch multiple decision requests for efficiency
   - Particularly useful for lookahead and analysis

3. **Caching**:
   - Cache decisions for identical or similar states
   - Especially useful during periods of low game state change

4. **Advanced RL Techniques**:
   - Integrate more sophisticated RL algorithms as they prove effective
   - Experiment with different network architectures for value function