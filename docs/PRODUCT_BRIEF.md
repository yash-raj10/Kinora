# Kinora: product brief and video script

## The one-line pitch
**Kinora is a movie rating site where every rating is backed by real money, and where you can bet on the box office.**
Opinions that cost something to give are opinions you can trust.

## What Kinora is
Kinora lists recent theatrical releases. For each movie you can do two things:

1. **Call it.** Pick one of four verdicts, Skip, Timepass, Go for it or Perfection, and back your call with a small NEAR stake.
2. **Bet on the box office.** Pick Over or Under on a movie's US gross, or pick which of two new releases will earn more.

Everything runs on the NEAR blockchain. You sign in with your own NEAR wallet, and the rules, the stakes and the payouts are handled by a smart contract, not by us.

## Why it matters
- **Ratings you can trust.** On most sites a rating is free to give, so a crowd can be faked. On Kinora a vote has a stake behind it, and vote weight comes from your voting history, never from how much you pay.
- **Nobody holds your money.** Stakes sit in the contract and go back to you under rules anyone can read.
- **Being right is rewarded.** Correct calls earn a share of the pool and climb a public leaderboard.
- **Nothing is hidden.** Box-office numbers arrive on-chain with a link to the source and a fingerprint of the original data.

## How voting works
| Step | What happens |
|---|---|
| **1. Open** | Each movie is open for voting for **10 days**. |
| **2. Call it** | Connect a wallet, choose a verdict, and stake at least **0.1 NEAR**. One vote per movie. |
| **3. Close** | After 10 days voting closes and the stakes are locked. |
| **4. Verdict** | Anyone can lock in the final verdict. The winning verdict is the one with the most **weighted votes**. |
| **5. Payout** | Each voter claims for themselves (see below). |

### The payout rules
- **Called it right:** you get your whole stake back **plus a share of the slashed pool**, split in proportion to your stake.
- **Called it wrong:** you lose **20%** of your stake and get the other 80% back. That 20% is the slashed pool.
- **Safety net:** if nobody locks in a verdict within **7 days** of voting closing, everyone gets their full stake back.

Example: five people back the winning verdict with 0.6, 0.1, 0.1, 0.1 and 0.1 NEAR, and the losing side staked 1.0 NEAR in total. The slashed pool is 0.2 NEAR. The 0.6 staker gets back 0.72 NEAR, and each 0.1 staker gets back 0.12 NEAR.

## Levels: seasoned voters count more
Every vote you cast raises your level. A higher level makes your vote weigh more.

| Level | Vote weight |
|---|---|
| 1 | 1.0x |
| 2 | 1.25x |
| 3 | 1.5x |
| 4 | 2.0x |

You level up as you vote (every 15 votes in the standard setting). **Weight comes from your history, not your wallet**, so a big stake can't buy the verdict.

## The leaderboard
- Every correct call earns **10 Taste Score points**.
- Reach **30 points** to earn the **Critic** badge.
- The leaderboard ranks everyone by Taste Score, and shows how many votes were correct out of how many cast.

It's a public record of who actually has good taste.

## Box-office calls
Two kinds of bet on a movie's **US domestic gross**:

- **Over/Under:** "Will Clayface gross more than $50M?"
- **Head-to-head:** "Which earns more at the US box office: Clayface or Primetime?"

### How a box-office bet works
| Step | What happens |
|---|---|
| **1. Open** | A market opens with a threshold, or two movies for a head-to-head. |
| **2. Bet** | Pick a side and stake at least **0.1 NEAR**. One bet per market. |
| **3. Betting closes** | Typically a few days after the market opens. No new bets, and the stakes are locked. |
| **4. Wait** | The movie keeps earning. Resolution opens about a week later. |
| **5. Reading** | The keeper fetches the latest US gross from OMDb and posts it on-chain with a link to the source and a **SHA-256 fingerprint** of the original data. |
| **6. Resolve** | The market settles, and the winning side is known. Anyone can trigger this. |
| **7. Claim** | Winners claim their stake **plus a share of the losing side's pool**, split by stake. |

If no reading arrives within 7 days, or nobody backed the winning side, or a head-to-head ties, **every stake is refunded in full**.

### It runs itself
A scheduled **keeper** checks every **30 minutes**. When a market is due, it posts the reading and settles the market without anyone running anything. Winners just click **Claim payout**.

## Timelines at a glance
All three run on a simple 10-day clock.

### 1. Meter voting
```
Day 0 [============ voting open ============] Day 10  →  verdict  →  claim
```
| Day | What happens |
|---|---|
| 0 | The movie opens for voting |
| 0 to 10 | Anyone can vote: stake at least 0.1 NEAR, one vote each |
| 10 | Voting closes and the stakes are locked |
| 10 onward | Anyone presses **Finalize verdict**. One click counts the weighted votes and saves the winning verdict on-chain. Then every voter can claim |
| 17 | Safety net: if no verdict was locked in, everyone can claim their full stake back |

### 2. Over/Under bet
```
Day 0 [= betting =] Day 3 [======= waiting =======] Day 10  →  settle  →  claim
```
| Day | What happens |
|---|---|
| 0 | The market opens with a fixed threshold, for example $50M |
| 0 to 3 | Betting is open |
| 3 | Betting closes and the stakes are locked |
| 3 to 10 | The movie keeps earning, and nothing happens in the market |
| 10 | Resolution opens. The keeper posts the latest US gross within about 30 minutes, and the market settles |
| 10 onward | Winners claim their stake plus a share of the losing side's pool |

### 3. Head-to-head bet
Same 10-day clock as Over/Under: **3 days of betting, a 7-day wait, settle on day 10.**
- Two movies are paired when they opened within about a week of each other.
- Both are measured **on the same day**: the keeper posts a reading for each, and the higher US gross wins.
- If the two grosses are exactly equal, every stake is refunded.

### How a threshold is chosen
Each Over/Under market has one fixed threshold, set when it opens. It is a **round number just above the movie's current gross**, so the result is genuinely uncertain. For example, Primetime stands at $46.8M, so its market asks "Will it pass $50M?". The threshold doesn't move. On day 10 a single reading decides whether the gross is above or below it. A movie can have several thresholds at once, such as $50M, $60M and $75M, each as its own market.

## Where to find it
- Code: https://github.com/yash-raj10/Kinora
- Contract on NEAR testnet: `kinora-yash-1114.testnet`
