// Kinora: staked, Moctale-style 4-bucket movie Meter on NEAR.
// Vote weight comes from a voter's settled-vote history (levels), not from stake size.
// Stake decides money: winners get their stake back plus a share of the slashed losers' pool.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

pub const BUCKETS: usize = 4; // 0 Skip, 1 Timepass, 2 Go for it, 3 Perfection
pub const POINTS_PER_MATCH: u32 = 10;
pub const LEVEL_WEIGHTS: [u32; 4] = [100, 125, 150, 200]; // percent of a base vote
pub const FINALIZE_GRACE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_COMMENT_CHARS: usize = 280;
// Only the newest comments per movie are kept, so storage (paid from the contract balance) stays bounded.
pub const MAX_COMMENTS_PER_MOVIE: usize = 30;
const BPS: u128 = 10_000;
const SHARE_SCALE: u128 = 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Movie {
    pub id: u64,
    pub tmdb_id: u64,
    pub title: String,
    pub poster_url: String,
    pub release_ts_ms: U64,
    pub vote_end_ts_ms: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Vote {
    pub bucket: u8,
    pub stake: NearToken,
    pub ts_ms: U64,
    pub claimed: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Totals {
    pub counts: [u32; BUCKETS],
    pub stakes: [u128; BUCKETS],
}

#[near(serializers = [json])]
pub struct MeterView {
    pub counts: [u32; BUCKETS],
    pub stakes: [U128; BUCKETS],
    pub stake_pct: [u8; BUCKETS],
    pub weights: [U128; BUCKETS],
    pub weight_pct: [u8; BUCKETS],
    pub total_votes: u32,
    pub total_stake: U128,
    pub headline_bucket: Option<u8>,
    pub headline_pct: u8,
}

#[near(serializers = [json])]
pub struct MovieCard {
    pub movie: Movie,
    pub meter: MeterView,
    pub final_bucket: Option<u8>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub min_stake: NearToken,
    pub movie_count: u64,
    pub slash_bps: u16,
    pub level_step: u32,
    pub resolver: AccountId,
    pub market_count: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct Taste {
    pub calls: u32,
    pub matched: u32,
    pub score: u32,
}

#[near(serializers = [json])]
pub struct LeaderRow {
    pub account_id: AccountId,
    pub calls: u32,
    pub matched: u32,
    pub score: u32,
}

#[near(serializers = [json])]
pub struct Profile {
    pub calls: u32,
    pub matched: u32,
    pub score: u32,
    pub level: u8,
    pub weight: u32,
    pub next_level_in: Option<u32>,
}

#[near(serializers = [json])]
pub struct ClaimPreview {
    pub state: String, // "pending", "won" or "lost"
    pub payout: U128,
    pub claimed: bool,
}

pub const MARKET_THRESHOLD: u8 = 0;
pub const MARKET_DUEL: u8 = 1;

// Threshold market: side 0 = Under (at or below the threshold), side 1 = Over (strictly above it).
// Duel market: side 0 = movie A (`movie_id`) ends higher, side 1 = movie B (`movie_b`) ends higher; a tie voids it.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Market {
    pub id: u64,
    pub kind: u8,
    pub movie_id: u64,
    pub movie_b: Option<u64>,
    pub metric: String,
    pub threshold: u64,
    pub closes_at_ms: u64,
    pub resolves_at_ms: u64,
    pub pools: [u128; 2],
    pub counts: [u32; 2],
    pub outcome: Option<u8>,
    pub voided: bool,
    pub resolved_value: Option<u64>,
    pub resolved_value_b: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Bet {
    pub side: u8,
    pub stake: NearToken,
    pub claimed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct DataPoint {
    pub value: U64,
    pub source: String,
    pub source_url: String,
    pub evidence_hash: String,
    pub fetched_at_ms: U64,
    pub posted_at_ms: U64,
    pub poster: AccountId,
}

#[near(serializers = [json])]
pub struct MarketView {
    pub id: u64,
    pub kind: u8,
    pub movie_id: u64,
    pub movie_b: Option<u64>,
    pub metric: String,
    pub threshold: U64,
    pub closes_at_ms: U64,
    pub resolves_at_ms: U64,
    pub pools: [U128; 2],
    pub counts: [u32; 2],
    pub over_pct: u8,
    pub state: String, // "open", "closed", "resolved" or "void"
    pub outcome: Option<u8>,
    pub resolved_value: Option<U64>,
    pub resolved_value_b: Option<U64>,
}

#[near(serializers = [json])]
pub struct MarketClaimPreview {
    pub state: String, // "pending", "won", "lost" or "void"
    pub payout: U128,
    pub claimed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Comment {
    pub author: AccountId,
    pub text: String,
    pub ts_ms: U64,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Movies,
    Totals,
    Votes,
    Finals,
    Settled,
    Taste,
    Weights,
    WTotals,
    Markets,
    Bets,
    DataPoints,
    Comments,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    min_stake: NearToken,
    next_movie_id: u64,
    movies: LookupMap<u64, Movie>,
    totals: LookupMap<u64, Totals>,
    votes: LookupMap<String, Vote>,
    finals: LookupMap<u64, u8>,
    settled: LookupMap<String, bool>,
    taste: IterableMap<AccountId, Taste>,
    slash_bps: u16,
    level_step: u32,
    weights: LookupMap<String, u32>,
    wtotals: LookupMap<u64, [u128; BUCKETS]>,
    resolver: AccountId,
    next_market_id: u64,
    markets: LookupMap<u64, Market>,
    bets: LookupMap<String, Bet>,
    datapoints: LookupMap<u64, Vec<DataPoint>>,
    comments: LookupMap<u64, Vec<Comment>>,
}

// Layout before comments existed; read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV4 {
    owner: AccountId,
    min_stake: NearToken,
    next_movie_id: u64,
    movies: LookupMap<u64, Movie>,
    totals: LookupMap<u64, Totals>,
    votes: LookupMap<String, Vote>,
    finals: LookupMap<u64, u8>,
    settled: LookupMap<String, bool>,
    taste: IterableMap<AccountId, Taste>,
    slash_bps: u16,
    level_step: u32,
    weights: LookupMap<String, u32>,
    wtotals: LookupMap<u64, [u128; BUCKETS]>,
    resolver: AccountId,
    next_market_id: u64,
    markets: LookupMap<u64, Market>,
    bets: LookupMap<String, Bet>,
    datapoints: LookupMap<u64, Vec<DataPoint>>,
}

fn vote_key(movie_id: u64, account: &AccountId) -> String {
    format!("{movie_id}:{account}")
}

fn bet_key(market_id: u64, account: &AccountId) -> String {
    format!("m{market_id}:{account}")
}

// Voided markets refund every stake. Otherwise winners split the losing pool by stake and losers get nothing.
fn market_payout(m: &Market, bet: &Bet) -> u128 {
    let stake = bet.stake.as_yoctonear();
    if m.voided {
        return stake;
    }
    match m.outcome {
        Some(w) if bet.side == w => {
            let winners = m.pools[w as usize];
            let losers = m.pools[1 - w as usize];
            stake + losers * (stake * SHARE_SCALE / winners) / SHARE_SCALE
        }
        _ => 0,
    }
}

pub fn level_for(calls: u32, step: u32) -> u8 {
    (calls / step.max(1)).min(3) as u8
}

pub fn weight_for(level: u8) -> u32 {
    LEVEL_WEIGHTS[level as usize]
}

fn headline(weights: &[u128; BUCKETS]) -> Option<usize> {
    if weights.iter().sum::<u128>() == 0 {
        return None;
    }
    let mut head = 0usize;
    for i in 0..BUCKETS {
        if weights[i] >= weights[head] {
            head = i;
        }
    }
    Some(head)
}

fn pct(part: u128, total: u128) -> u8 {
    if total == 0 {
        0
    } else {
        (part * 100 / total) as u8
    }
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId, min_stake: NearToken) -> Self {
        Self {
            resolver: owner.clone(),
            next_market_id: 0,
            markets: LookupMap::new(StorageKey::Markets),
            bets: LookupMap::new(StorageKey::Bets),
            datapoints: LookupMap::new(StorageKey::DataPoints),
            owner,
            min_stake,
            next_movie_id: 0,
            movies: LookupMap::new(StorageKey::Movies),
            totals: LookupMap::new(StorageKey::Totals),
            votes: LookupMap::new(StorageKey::Votes),
            finals: LookupMap::new(StorageKey::Finals),
            settled: LookupMap::new(StorageKey::Settled),
            taste: IterableMap::new(StorageKey::Taste),
            slash_bps: 2000,
            level_step: 15,
            weights: LookupMap::new(StorageKey::Weights),
            wtotals: LookupMap::new(StorageKey::WTotals),
            comments: LookupMap::new(StorageKey::Comments),
        }
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV4 =
            env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"));
        Self {
            owner: old.owner,
            min_stake: old.min_stake,
            next_movie_id: old.next_movie_id,
            movies: old.movies,
            totals: old.totals,
            votes: old.votes,
            finals: old.finals,
            settled: old.settled,
            taste: old.taste,
            slash_bps: old.slash_bps,
            level_step: old.level_step,
            weights: old.weights,
            wtotals: old.wtotals,
            resolver: old.resolver,
            next_market_id: old.next_market_id,
            markets: old.markets,
            bets: old.bets,
            datapoints: old.datapoints,
            comments: LookupMap::new(StorageKey::Comments),
        }
    }

    pub fn add_movie(
        &mut self,
        tmdb_id: u64,
        title: String,
        poster_url: String,
        release_ts_ms: U64,
        vote_end_ts_ms: U64,
    ) -> u64 {
        self.assert_owner();
        require!(!title.is_empty(), "Title is required");
        let id = self.next_movie_id;
        self.next_movie_id += 1;
        self.movies.insert(
            id,
            Movie { id, tmdb_id, title, poster_url, release_ts_ms, vote_end_ts_ms },
        );
        id
    }

    pub fn update_movie(
        &mut self,
        movie_id: u64,
        tmdb_id: u64,
        title: String,
        poster_url: String,
        release_ts_ms: U64,
        vote_end_ts_ms: U64,
    ) {
        self.assert_owner();
        require!(!title.is_empty(), "Title is required");
        require!(self.movies.contains_key(&movie_id), "Movie not found");
        self.movies.insert(
            movie_id,
            Movie { id: movie_id, tmdb_id, title, poster_url, release_ts_ms, vote_end_ts_ms },
        );
    }

    pub fn set_min_stake(&mut self, min_stake: NearToken) {
        self.assert_owner();
        self.min_stake = min_stake;
    }

    pub fn set_slash_bps(&mut self, slash_bps: u16) {
        self.assert_owner();
        require!(slash_bps <= 5000, "Slash cannot exceed 50%");
        self.slash_bps = slash_bps;
    }

    pub fn set_level_step(&mut self, level_step: u32) {
        self.assert_owner();
        require!(level_step >= 1, "Level step must be at least 1");
        self.level_step = level_step;
    }

    #[payable]
    pub fn vote(&mut self, movie_id: u64, bucket: u8) {
        let vote_end = self.movie(movie_id).vote_end_ts_ms.0;
        let now = env::block_timestamp_ms();
        require!(now < vote_end, "Voting window is closed");
        require!((bucket as usize) < BUCKETS, "Invalid bucket");

        let stake = env::attached_deposit();
        require!(stake >= self.min_stake, "Stake is below the minimum");

        let voter = env::predecessor_account_id();
        let key = vote_key(movie_id, &voter);
        require!(!self.votes.contains_key(&key), "Already voted on this movie");

        let calls = self.taste.get(&voter).map(|t| t.calls).unwrap_or(0);
        let weight = weight_for(level_for(calls, self.level_step));

        let mut profile = self.taste.get(&voter).cloned().unwrap_or_default();
        profile.calls += 1;
        self.taste.insert(voter.clone(), profile);

        let mut w = self.bucket_weights(movie_id);
        w[bucket as usize] += weight as u128;
        self.wtotals.insert(movie_id, w);

        let mut totals = self.totals.get(&movie_id).cloned().unwrap_or_default();
        totals.counts[bucket as usize] += 1;
        totals.stakes[bucket as usize] += stake.as_yoctonear();
        self.totals.insert(movie_id, totals);

        self.weights.insert(key.clone(), weight);
        self.votes
            .insert(key, Vote { bucket, stake, ts_ms: U64(now), claimed: false });
    }

    pub fn finalize_meter(&mut self, movie_id: u64) -> u8 {
        let vote_end = self.movie(movie_id).vote_end_ts_ms.0;
        require!(env::block_timestamp_ms() >= vote_end, "Voting window is still open");
        require!(!self.finals.contains_key(&movie_id), "Already finalized");
        let head = headline(&self.bucket_weights(movie_id))
            .unwrap_or_else(|| env::panic_str("No votes to finalize")) as u8;
        self.finals.insert(movie_id, head);
        head
    }

    pub fn claim_bond(&mut self, movie_id: u64) -> Promise {
        let vote_end = self.movie(movie_id).vote_end_ts_ms.0;
        let now = env::block_timestamp_ms();
        require!(now >= vote_end, "Voting window is still open");

        let voter = env::predecessor_account_id();
        let key = vote_key(movie_id, &voter);
        let vote = self
            .votes
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No vote found for this account"));
        require!(!vote.claimed, "Bond already claimed");

        let final_bucket = self.finals.get(&movie_id).copied();
        let payout = match final_bucket {
            Some(f) => self.compute_payout(movie_id, &vote, f),
            None => {
                require!(
                    now >= vote_end + FINALIZE_GRACE_MS,
                    "Waiting for the verdict. Anyone can finalize once voting closes."
                );
                vote.stake.as_yoctonear()
            }
        };

        if let Some(v) = self.votes.get_mut(&key) {
            v.claimed = true;
        }
        if final_bucket.is_some() && !self.settled.contains_key(&key) {
            self.apply_settlement(movie_id, &voter);
        }
        Promise::new(voter).transfer(NearToken::from_yoctonear(payout))
    }

    // Recounts real on-chain votes for votes cast before they counted at vote time. Only raises the counter.
    pub fn sync_votes(&mut self, account_id: AccountId) -> u32 {
        let cast = (0..self.next_movie_id)
            .filter(|id| self.votes.contains_key(&vote_key(*id, &account_id)))
            .count() as u32;
        let mut t = self.taste.get(&account_id).cloned().unwrap_or_default();
        if cast > t.calls {
            t.calls = cast;
            self.taste.insert(account_id, t);
        }
        cast
    }

    pub fn settle_taste(&mut self, movie_id: u64, account_id: AccountId) {
        self.apply_settlement(movie_id, &account_id);
    }

    pub fn set_resolver(&mut self, resolver: AccountId) {
        self.assert_owner();
        self.resolver = resolver;
    }

    pub fn create_market(
        &mut self,
        movie_id: u64,
        metric: String,
        threshold: U64,
        closes_at_ms: U64,
        resolves_at_ms: U64,
    ) -> u64 {
        self.assert_owner();
        require!(self.movies.contains_key(&movie_id), "Movie not found");
        require!(!metric.is_empty(), "Metric is required");
        require!(threshold.0 > 0, "Threshold must be above zero");
        require!(closes_at_ms.0 <= resolves_at_ms.0, "Betting must close before resolution");
        let id = self.next_market_id;
        self.next_market_id += 1;
        self.markets.insert(
            id,
            Market {
                id,
                kind: MARKET_THRESHOLD,
                movie_id,
                movie_b: None,
                metric,
                threshold: threshold.0,
                closes_at_ms: closes_at_ms.0,
                resolves_at_ms: resolves_at_ms.0,
                pools: [0; 2],
                counts: [0; 2],
                outcome: None,
                voided: false,
                resolved_value: None,
                resolved_value_b: None,
            },
        );
        id
    }

    pub fn create_duel(
        &mut self,
        movie_a: u64,
        movie_b: u64,
        metric: String,
        closes_at_ms: U64,
        resolves_at_ms: U64,
    ) -> u64 {
        self.assert_owner();
        require!(movie_a != movie_b, "A duel needs two different movies");
        require!(self.movies.contains_key(&movie_a), "Movie not found");
        require!(self.movies.contains_key(&movie_b), "Movie not found");
        require!(!metric.is_empty(), "Metric is required");
        require!(closes_at_ms.0 <= resolves_at_ms.0, "Betting must close before resolution");
        let id = self.next_market_id;
        self.next_market_id += 1;
        self.markets.insert(
            id,
            Market {
                id,
                kind: MARKET_DUEL,
                movie_id: movie_a,
                movie_b: Some(movie_b),
                metric,
                threshold: 0,
                closes_at_ms: closes_at_ms.0,
                resolves_at_ms: resolves_at_ms.0,
                pools: [0; 2],
                counts: [0; 2],
                outcome: None,
                voided: false,
                resolved_value: None,
                resolved_value_b: None,
            },
        );
        id
    }

    // The data agent calls this on a schedule. `posted_at_ms` is the chain's clock, so it cannot be backdated.
    pub fn post_data_point(
        &mut self,
        movie_id: u64,
        value: U64,
        source: String,
        source_url: String,
        evidence_hash: String,
        fetched_at_ms: U64,
    ) {
        let poster = env::predecessor_account_id();
        require!(
            poster == self.resolver || poster == self.owner,
            "Only the resolver can post data"
        );
        require!(self.movies.contains_key(&movie_id), "Movie not found");
        require!(!source.is_empty(), "Source is required");
        let mut points = self.datapoints.get(&movie_id).cloned().unwrap_or_default();
        require!(points.len() < 200, "Too many data points for this movie");
        points.push(DataPoint {
            value,
            source,
            source_url,
            evidence_hash,
            fetched_at_ms,
            posted_at_ms: U64(env::block_timestamp_ms()),
            poster,
        });
        self.datapoints.insert(movie_id, points);
    }

    #[payable]
    pub fn bet(&mut self, market_id: u64, side: u8) {
        require!(side < 2, "Side must be 0 (Under) or 1 (Over)");
        let stake = env::attached_deposit();
        require!(stake >= self.min_stake, "Stake is below the minimum");
        let bettor = env::predecessor_account_id();
        let key = bet_key(market_id, &bettor);
        require!(!self.bets.contains_key(&key), "Already bet on this market");

        let now = env::block_timestamp_ms();
        let m = self
            .markets
            .get_mut(&market_id)
            .unwrap_or_else(|| env::panic_str("Market not found"));
        require!(m.outcome.is_none() && !m.voided, "Market is settled");
        require!(now < m.closes_at_ms, "Betting is closed");
        m.pools[side as usize] += stake.as_yoctonear();
        m.counts[side as usize] += 1;

        self.bets.insert(key, Bet { side, stake, claimed: false });
    }

    pub fn resolve_market(&mut self, market_id: u64) {
        let now = env::block_timestamp_ms();
        let (kind, movie_id, movie_b, resolves_at, threshold) = {
            let m = self.market(market_id);
            require!(m.outcome.is_none() && !m.voided, "Already resolved");
            (m.kind, m.movie_id, m.movie_b, m.resolves_at_ms, m.threshold)
        };
        require!(now >= resolves_at, "Too early to resolve");

        // The first reading per movie posted at or after the resolve time decides the market.
        let reading_a = self.first_reading(movie_id, resolves_at);
        let reading_b = match (kind, movie_b) {
            (MARKET_DUEL, Some(b)) => self.first_reading(b, resolves_at),
            _ => None,
        };
        let ready = reading_a.is_some() && (kind != MARKET_DUEL || reading_b.is_some());
        if !ready {
            require!(
                now >= resolves_at + FINALIZE_GRACE_MS,
                "Waiting for resolution data from the resolver"
            );
        }

        let m = self
            .markets
            .get_mut(&market_id)
            .unwrap_or_else(|| env::panic_str("Market not found"));
        let a = match reading_a {
            Some(a) if ready => a,
            _ => {
                m.voided = true;
                return;
            }
        };
        m.resolved_value = Some(a);
        let winning_side: Option<usize> = if kind == MARKET_DUEL {
            let b = reading_b.unwrap_or_default();
            m.resolved_value_b = Some(b);
            if a > b {
                Some(0)
            } else if b > a {
                Some(1)
            } else {
                None
            }
        } else if a > threshold {
            Some(1)
        } else {
            Some(0)
        };
        match winning_side {
            Some(side) if m.pools[side] > 0 => m.outcome = Some(side as u8),
            _ => m.voided = true,
        }
    }

    pub fn claim_market(&mut self, market_id: u64) -> PromiseOrValue<()> {
        let m = self.market(market_id).clone();
        require!(m.voided || m.outcome.is_some(), "Market is not resolved yet");
        let bettor = env::predecessor_account_id();
        let key = bet_key(market_id, &bettor);
        let bet = self
            .bets
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No bet found for this account"));
        require!(!bet.claimed, "Bet already claimed");

        let payout = market_payout(&m, &bet);
        if let Some(b) = self.bets.get_mut(&key) {
            b.claimed = true;
        }
        if payout > 0 {
            Promise::new(bettor).transfer(NearToken::from_yoctonear(payout)).into()
        } else {
            PromiseOrValue::Value(())
        }
    }

    pub fn get_market(&self, market_id: u64) -> Option<MarketView> {
        self.markets.get(&market_id).map(|m| self.market_view(m))
    }

    pub fn get_markets(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<MarketView> {
        let from = from_index.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(50)).min(self.next_market_id);
        (from..end)
            .filter_map(|id| self.markets.get(&id).map(|m| self.market_view(m)))
            .collect()
    }

    pub fn get_bet(&self, market_id: u64, account_id: AccountId) -> Option<Bet> {
        self.bets.get(&bet_key(market_id, &account_id)).cloned()
    }

    pub fn preview_market_claim(
        &self,
        market_id: u64,
        account_id: AccountId,
    ) -> Option<MarketClaimPreview> {
        let m = self.markets.get(&market_id)?;
        let bet = self.bets.get(&bet_key(market_id, &account_id))?;
        let settled = m.voided || m.outcome.is_some();
        let state = if m.voided {
            "void"
        } else if let Some(w) = m.outcome {
            if bet.side == w { "won" } else { "lost" }
        } else {
            "pending"
        };
        Some(MarketClaimPreview {
            state: state.to_string(),
            payout: U128(if settled { market_payout(m, bet) } else { bet.stake.as_yoctonear() }),
            claimed: bet.claimed,
        })
    }

    pub fn get_data_points(&self, movie_id: u64) -> Vec<DataPoint> {
        self.datapoints.get(&movie_id).cloned().unwrap_or_default()
    }

    // Anyone with a wallet can comment. Posting again replaces your earlier comment on that movie.
    pub fn post_comment(&mut self, movie_id: u64, text: String) {
        require!(self.movies.contains_key(&movie_id), "Movie not found");
        let text = text.trim().to_string();
        require!(!text.is_empty(), "Comment cannot be empty");
        require!(text.chars().count() <= MAX_COMMENT_CHARS, "Comment is too long");

        let author = env::predecessor_account_id();
        let mut list = self.comments.get(&movie_id).cloned().unwrap_or_default();
        list.retain(|c| c.author != author);
        list.push(Comment { author, text, ts_ms: U64(env::block_timestamp_ms()) });
        if list.len() > MAX_COMMENTS_PER_MOVIE {
            list.remove(0);
        }
        self.comments.insert(movie_id, list);
    }

    pub fn get_comments(&self, movie_id: u64, from_index: Option<u64>, limit: Option<u64>) -> Vec<Comment> {
        self.comments
            .get(&movie_id)
            .map(|list| {
                list.iter()
                    .rev()
                    .skip(from_index.unwrap_or(0) as usize)
                    .take(limit.unwrap_or(MAX_COMMENTS_PER_MOVIE as u64) as usize)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_comment_count(&self, movie_id: u64) -> u64 {
        self.comments.get(&movie_id).map(|l| l.len() as u64).unwrap_or(0)
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            min_stake: self.min_stake,
            movie_count: self.next_movie_id,
            slash_bps: self.slash_bps,
            level_step: self.level_step,
            resolver: self.resolver.clone(),
            market_count: self.next_market_id,
        }
    }

    pub fn get_movie(&self, movie_id: u64) -> Option<Movie> {
        self.movies.get(&movie_id).cloned()
    }

    pub fn get_movies(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Movie> {
        let from = from_index.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(50)).min(self.next_movie_id);
        (from..end).filter_map(|id| self.movies.get(&id).cloned()).collect()
    }

    pub fn get_overview(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<MovieCard> {
        let from = from_index.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(40)).min(self.next_movie_id);
        (from..end)
            .filter_map(|id| {
                self.movies.get(&id).map(|m| MovieCard {
                    movie: m.clone(),
                    meter: self.get_meter(id),
                    final_bucket: self.finals.get(&id).copied(),
                })
            })
            .collect()
    }

    pub fn get_vote(&self, movie_id: u64, account_id: AccountId) -> Option<Vote> {
        self.votes.get(&vote_key(movie_id, &account_id)).cloned()
    }

    pub fn get_vote_weight(&self, movie_id: u64, account_id: AccountId) -> Option<u32> {
        let key = vote_key(movie_id, &account_id);
        self.votes
            .get(&key)
            .map(|_| self.weights.get(&key).copied().unwrap_or(100))
    }

    pub fn get_meter(&self, movie_id: u64) -> MeterView {
        let t = self.totals.get(&movie_id).cloned().unwrap_or_default();
        let w = self.bucket_weights(movie_id);
        let total_stake: u128 = t.stakes.iter().sum();
        let total_votes: u32 = t.counts.iter().sum();
        let total_weight: u128 = w.iter().sum();

        let mut stake_pct = [0u8; BUCKETS];
        let mut weight_pct = [0u8; BUCKETS];
        for i in 0..BUCKETS {
            stake_pct[i] = pct(t.stakes[i], total_stake);
            weight_pct[i] = pct(w[i], total_weight);
        }
        let head = headline(&w);

        MeterView {
            counts: t.counts,
            stakes: t.stakes.map(U128),
            stake_pct,
            weights: w.map(U128),
            weight_pct,
            total_votes,
            total_stake: U128(total_stake),
            headline_bucket: head.map(|h| h as u8),
            headline_pct: head.map(|h| weight_pct[h]).unwrap_or(0),
        }
    }

    pub fn get_final(&self, movie_id: u64) -> Option<u8> {
        self.finals.get(&movie_id).copied()
    }

    pub fn is_settled(&self, movie_id: u64, account_id: AccountId) -> bool {
        self.settled.contains_key(&vote_key(movie_id, &account_id))
    }

    pub fn preview_claim(&self, movie_id: u64, account_id: AccountId) -> Option<ClaimPreview> {
        let vote = self.votes.get(&vote_key(movie_id, &account_id))?;
        Some(match self.finals.get(&movie_id) {
            Some(&f) => ClaimPreview {
                state: if vote.bucket == f { "won" } else { "lost" }.to_string(),
                payout: U128(self.compute_payout(movie_id, vote, f)),
                claimed: vote.claimed,
            },
            None => ClaimPreview {
                state: "pending".to_string(),
                payout: U128(vote.stake.as_yoctonear()),
                claimed: vote.claimed,
            },
        })
    }

    pub fn get_taste(&self, account_id: AccountId) -> Taste {
        self.taste.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_profile(&self, account_id: AccountId) -> Profile {
        let t = self.taste.get(&account_id).cloned().unwrap_or_default();
        let level = level_for(t.calls, self.level_step);
        let step = self.level_step.max(1);
        Profile {
            calls: t.calls,
            matched: t.matched,
            score: t.score,
            level,
            weight: weight_for(level),
            next_level_in: if level < 3 { Some(step - t.calls % step) } else { None },
        }
    }

    pub fn get_leaderboard(&self, limit: Option<u64>) -> Vec<LeaderRow> {
        let mut rows: Vec<LeaderRow> = self
            .taste
            .iter()
            .map(|(account_id, t)| LeaderRow {
                account_id: account_id.clone(),
                calls: t.calls,
                matched: t.matched,
                score: t.score,
            })
            .collect();
        rows.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(b.matched.cmp(&a.matched))
                .then(a.account_id.cmp(&b.account_id))
        });
        rows.truncate(limit.unwrap_or(20) as usize);
        rows
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    fn market(&self, market_id: u64) -> &Market {
        self.markets
            .get(&market_id)
            .unwrap_or_else(|| env::panic_str("Market not found"))
    }

    fn market_view(&self, m: &Market) -> MarketView {
        let total = m.pools[0] + m.pools[1];
        let state = if m.voided {
            "void"
        } else if m.outcome.is_some() {
            "resolved"
        } else if env::block_timestamp_ms() < m.closes_at_ms {
            "open"
        } else {
            "closed"
        };
        MarketView {
            id: m.id,
            kind: m.kind,
            movie_id: m.movie_id,
            movie_b: m.movie_b,
            metric: m.metric.clone(),
            threshold: U64(m.threshold),
            closes_at_ms: U64(m.closes_at_ms),
            resolves_at_ms: U64(m.resolves_at_ms),
            pools: m.pools.map(U128),
            counts: m.counts,
            over_pct: pct(m.pools[1], total),
            state: state.to_string(),
            outcome: m.outcome,
            resolved_value: m.resolved_value.map(U64),
            resolved_value_b: m.resolved_value_b.map(U64),
        }
    }

    fn first_reading(&self, movie_id: u64, at_or_after_ms: u64) -> Option<u64> {
        self.datapoints.get(&movie_id).and_then(|v| {
            v.iter()
                .find(|d| d.posted_at_ms.0 >= at_or_after_ms)
                .map(|d| d.value.0)
        })
    }

    fn movie(&self, movie_id: u64) -> &Movie {
        self.movies
            .get(&movie_id)
            .unwrap_or_else(|| env::panic_str("Movie not found"))
    }

    // Movies voted on before weights existed have no entry; each of their votes counts as 1.0x.
    fn bucket_weights(&self, movie_id: u64) -> [u128; BUCKETS] {
        if let Some(w) = self.wtotals.get(&movie_id) {
            return *w;
        }
        self.totals
            .get(&movie_id)
            .cloned()
            .unwrap_or_default()
            .counts
            .map(|c| c as u128 * 100)
    }

    // Winners keep their stake and split the slashed pool by stake; losers lose `slash_bps` (rounded up).
    fn compute_payout(&self, movie_id: u64, vote: &Vote, final_bucket: u8) -> u128 {
        let t = self.totals.get(&movie_id).cloned().unwrap_or_default();
        let stake = vote.stake.as_yoctonear();
        let slash = self.slash_bps as u128;
        let total: u128 = t.stakes.iter().sum();
        let winning = t.stakes[final_bucket as usize];

        if vote.bucket == final_bucket && winning > 0 {
            let pool = (total - winning) * slash / BPS;
            let share = stake * SHARE_SCALE / winning;
            stake + pool * share / SHARE_SCALE
        } else {
            stake - (stake * slash + BPS - 1) / BPS
        }
    }

    fn apply_settlement(&mut self, movie_id: u64, account: &AccountId) {
        let final_bucket = *self
            .finals
            .get(&movie_id)
            .unwrap_or_else(|| env::panic_str("Movie is not finalized"));
        let key = vote_key(movie_id, account);
        let voted = self
            .votes
            .get(&key)
            .unwrap_or_else(|| env::panic_str("No vote found for this account"))
            .bucket;
        require!(!self.settled.contains_key(&key), "Taste already settled");
        self.settled.insert(key, true);

        let mut t = self.taste.get(account).cloned().unwrap_or_default();
        if voted == final_bucket {
            t.matched += 1;
            t.score += POINTS_PER_MATCH;
        }
        self.taste.insert(account.clone(), t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OPEN_MS: u64 = 1_000;
    const END_MS: u64 = 10_000;

    fn milli(n: u128) -> u128 {
        NearToken::from_millinear(n).as_yoctonear()
    }

    fn ctx(predecessor: &str, deposit: NearToken, ts_ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(deposit)
            .block_timestamp(ts_ms * 1_000_000);
        b
    }

    fn zero() -> NearToken {
        NearToken::from_yoctonear(0)
    }

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn setup() -> Contract {
        testing_env!(ctx("owner.near", zero(), OPEN_MS).build());
        let mut c = Contract::init(acct("owner.near"), NearToken::from_millinear(100));
        c.add_movie(1, "Rockstar".into(), String::new(), U64(500), U64(END_MS));
        c
    }

    fn vote_on(c: &mut Contract, movie: u64, who: &str, near_milli: u128, bucket: u8, ts_ms: u64) {
        testing_env!(ctx(who, NearToken::from_millinear(near_milli), ts_ms).build());
        c.vote(movie, bucket);
    }

    fn vote_as(c: &mut Contract, who: &str, near_milli: u128, bucket: u8, ts_ms: u64) {
        vote_on(c, 0, who, near_milli, bucket, ts_ms);
    }

    fn finalize(c: &mut Contract, ts_ms: u64) -> u8 {
        testing_env!(ctx("anyone.near", zero(), ts_ms).build());
        c.finalize_meter(0)
    }

    fn as_user(who: &str, ts_ms: u64) {
        testing_env!(ctx(who, zero(), ts_ms).build());
    }

    #[test]
    fn votes_update_meter_by_weight_and_stake() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        vote_as(&mut c, "bob.near", 500, 2, OPEN_MS);

        let m = c.get_meter(0);
        assert_eq!(m.counts, [0, 0, 1, 1]);
        assert_eq!(m.total_votes, 2);
        assert_eq!(m.weight_pct, [0, 0, 50, 50]);
        assert_eq!(m.stake_pct, [0, 0, 33, 66]);
        assert_eq!(m.headline_bucket, Some(3));
        assert_eq!(m.headline_pct, 50);
    }

    #[test]
    fn empty_meter_has_no_headline() {
        let c = setup();
        let m = c.get_meter(0);
        assert_eq!(m.headline_bucket, None);
        assert_eq!(m.total_votes, 0);
    }

    #[test]
    #[should_panic(expected = "Already voted")]
    fn double_vote_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        vote_as(&mut c, "alice.near", 1000, 1, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "below the minimum")]
    fn low_stake_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 50, 3, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "Invalid bucket")]
    fn bad_bucket_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 4, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "closed")]
    fn vote_after_close_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, END_MS);
    }

    #[test]
    #[should_panic(expected = "still open")]
    fn claim_before_close_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        as_user("alice.near", OPEN_MS);
        let _ = c.claim_bond(0);
    }

    #[test]
    #[should_panic(expected = "already claimed")]
    fn bond_claimed_once() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        as_user("alice.near", END_MS);
        let _ = c.claim_bond(0);
        assert!(c.get_vote(0, acct("alice.near")).unwrap().claimed);
        let _ = c.claim_bond(0);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_owner_adds_movies() {
        let mut c = setup();
        as_user("mallory.near", OPEN_MS);
        c.add_movie(2, "Fake".into(), String::new(), U64(0), U64(END_MS));
    }

    #[test]
    fn owner_can_update_movie() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.update_movie(0, 9, "Rockstar (2011)".into(), "http://p".into(), U64(1), U64(END_MS));
        let m = c.get_movie(0).unwrap();
        assert_eq!(m.title, "Rockstar (2011)");
        assert_eq!(c.get_config().movie_count, 1);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_owner_updates_movies() {
        let mut c = setup();
        as_user("mallory.near", OPEN_MS);
        c.update_movie(0, 9, "X".into(), String::new(), U64(0), U64(END_MS));
    }

    #[test]
    #[should_panic(expected = "cannot exceed")]
    fn slash_is_capped() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.set_slash_bps(6000);
    }

    #[test]
    fn finalize_follows_weighted_votes_not_stake() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 5000, 3, OPEN_MS);
        vote_as(&mut c, "bob.near", 100, 2, OPEN_MS);
        vote_as(&mut c, "carol.near", 100, 2, OPEN_MS);
        assert_eq!(finalize(&mut c, END_MS), 2);
        assert_eq!(c.get_final(0), Some(2));
    }

    #[test]
    #[should_panic(expected = "still open")]
    fn finalize_before_close_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        finalize(&mut c, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "No votes")]
    fn finalize_without_votes_rejected() {
        let mut c = setup();
        finalize(&mut c, END_MS);
    }

    #[test]
    #[should_panic(expected = "Already finalized")]
    fn finalize_twice_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        finalize(&mut c, END_MS);
    }

    #[test]
    #[should_panic(expected = "not finalized")]
    fn settle_before_finalize_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        as_user("anyone.near", END_MS);
        c.settle_taste(0, acct("alice.near"));
    }

    #[test]
    fn settlement_scores_matches_and_misses() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        vote_as(&mut c, "bob.near", 100, 1, OPEN_MS);
        finalize(&mut c, END_MS);

        as_user("anyone.near", END_MS);
        c.settle_taste(0, acct("alice.near"));
        c.settle_taste(0, acct("bob.near"));

        let alice = c.get_taste(acct("alice.near"));
        assert_eq!((alice.calls, alice.matched, alice.score), (1, 1, POINTS_PER_MATCH));
        let bob = c.get_taste(acct("bob.near"));
        assert_eq!((bob.calls, bob.matched, bob.score), (1, 0, 0));

        let board = c.get_leaderboard(None);
        assert_eq!(board.len(), 2);
        assert_eq!(board[0].account_id.as_str(), "alice.near");
        assert_eq!(c.get_leaderboard(Some(1)).len(), 1);
    }

    #[test]
    #[should_panic(expected = "already settled")]
    fn settle_twice_rejected() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        as_user("anyone.near", END_MS);
        c.settle_taste(0, acct("alice.near"));
        c.settle_taste(0, acct("alice.near"));
    }

    #[test]
    fn claim_after_finalize_settles_taste() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        as_user("alice.near", END_MS);
        let _ = c.claim_bond(0);
        assert!(c.is_settled(0, acct("alice.near")));
        assert_eq!(c.get_taste(acct("alice.near")).score, POINTS_PER_MATCH);
    }

    #[test]
    #[should_panic(expected = "Waiting for the verdict")]
    fn claim_waits_for_finalize() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        as_user("alice.near", END_MS);
        let _ = c.claim_bond(0);
    }

    #[test]
    fn unfinalized_movie_refunds_in_full_after_grace() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        let preview = c.preview_claim(0, acct("alice.near")).unwrap();
        assert_eq!(preview.state, "pending");
        assert_eq!(preview.payout.0, milli(1000));

        as_user("alice.near", END_MS + FINALIZE_GRACE_MS);
        let _ = c.claim_bond(0);
        assert!(c.get_vote(0, acct("alice.near")).unwrap().claimed);
        assert!(!c.is_settled(0, acct("alice.near")));
    }

    #[test]
    fn winners_split_the_slashed_pool_by_stake() {
        let mut c = setup();
        // winners on Perfection: 0.6 + 4 x 0.1 = 1.0 NEAR
        vote_as(&mut c, "alice.near", 600, 3, OPEN_MS);
        for who in ["w1.near", "w2.near", "w3.near", "w4.near"] {
            vote_as(&mut c, who, 100, 3, OPEN_MS);
        }
        // losers on Timepass: 4 x 0.25 = 1.0 NEAR
        for who in ["l1.near", "l2.near", "l3.near", "l4.near"] {
            vote_as(&mut c, who, 250, 1, OPEN_MS);
        }
        assert_eq!(finalize(&mut c, END_MS), 3);

        let pay = |c: &Contract, who: &str| c.preview_claim(0, acct(who)).unwrap().payout.0;
        // pool = 20% of 1.0 = 0.2 NEAR
        assert_eq!(pay(&c, "alice.near"), milli(720));
        assert_eq!(pay(&c, "w1.near"), milli(120));
        assert_eq!(pay(&c, "l1.near"), milli(200));

        let paid = pay(&c, "alice.near")
            + ["w1.near", "w2.near", "w3.near", "w4.near"].iter().map(|w| pay(&c, w)).sum::<u128>()
            + ["l1.near", "l2.near", "l3.near", "l4.near"].iter().map(|w| pay(&c, w)).sum::<u128>();
        assert!(paid <= milli(2000), "contract must never pay out more than was staked");
        assert!(milli(2000) - paid < 1_000_000, "only rounding dust may remain");
        assert_eq!(c.preview_claim(0, acct("alice.near")).unwrap().state, "won");
        assert_eq!(c.preview_claim(0, acct("l1.near")).unwrap().state, "lost");
    }

    #[test]
    fn winners_with_no_losers_get_their_stake_back() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 600, 3, OPEN_MS);
        vote_as(&mut c, "bob.near", 100, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        assert_eq!(c.preview_claim(0, acct("alice.near")).unwrap().payout.0, milli(600));
    }

    #[test]
    fn level_and_weight_tables() {
        assert_eq!(level_for(0, 15), 0);
        assert_eq!(level_for(14, 15), 0);
        assert_eq!(level_for(15, 15), 1);
        assert_eq!(level_for(45, 15), 3);
        assert_eq!(level_for(10_000, 15), 3);
        assert_eq!(weight_for(0), 100);
        assert_eq!(weight_for(1), 125);
        assert_eq!(weight_for(3), 200);
    }

    #[test]
    fn every_vote_counts_toward_level_immediately() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.set_level_step(1);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));

        vote_as(&mut c, "alice.near", 100, 3, OPEN_MS);
        assert_eq!(c.get_vote_weight(0, acct("alice.near")), Some(100));

        // no finalize, no claim: the vote already counts
        let p = c.get_profile(acct("alice.near"));
        assert_eq!((p.calls, p.matched, p.score), (1, 0, 0));
        assert_eq!((p.level, p.weight), (1, 125));
        assert_eq!(p.next_level_in, Some(1));

        vote_on(&mut c, 1, "alice.near", 100, 3, OPEN_MS);
        assert_eq!(c.get_meter(1).weights[3].0, 125);
        assert_eq!(c.get_vote_weight(1, acct("alice.near")), Some(125));
    }

    #[test]
    fn sync_votes_repairs_legacy_counts_and_only_raises() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        vote_on(&mut c, 0, "alice.near", 100, 3, OPEN_MS);
        vote_on(&mut c, 1, "alice.near", 100, 3, OPEN_MS);

        // simulate votes cast before counting existed
        c.taste.insert(acct("alice.near"), Taste { calls: 0, matched: 1, score: 10 });
        as_user("anyone.near", OPEN_MS);
        assert_eq!(c.sync_votes(acct("alice.near")), 2);
        let t = c.get_taste(acct("alice.near"));
        assert_eq!((t.calls, t.matched, t.score), (2, 1, 10));

        // idempotent, never lowers, and never invents a profile
        assert_eq!(c.sync_votes(acct("alice.near")), 2);
        assert_eq!(c.get_taste(acct("alice.near")).calls, 2);
        assert_eq!(c.sync_votes(acct("nobody.near")), 0);
        assert!(c.get_leaderboard(None).iter().all(|r| r.account_id.as_str() != "nobody.near"));
    }

    #[test]
    fn settling_adds_matches_but_never_recounts_the_vote() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 100, 3, OPEN_MS);
        finalize(&mut c, END_MS);
        as_user("alice.near", END_MS);
        let _ = c.claim_bond(0);
        let p = c.get_profile(acct("alice.near"));
        assert_eq!((p.calls, p.matched, p.score), (1, 1, POINTS_PER_MATCH));
    }

    #[test]
    fn movies_voted_before_weights_count_as_one_x() {
        let mut c = setup();
        c.totals.insert(
            0,
            Totals { counts: [0, 0, 0, 1], stakes: [0, 0, 0, milli(100)] },
        );
        let m = c.get_meter(0);
        assert_eq!(m.weights[3].0, 100);
        assert_eq!(m.headline_bucket, Some(3));

        vote_as(&mut c, "bob.near", 100, 3, OPEN_MS);
        assert_eq!(c.get_meter(0).weights[3].0, 200);
    }

    #[test]
    fn overview_bundles_movie_meter_and_final() {
        let mut c = setup();
        vote_as(&mut c, "alice.near", 1000, 3, OPEN_MS);
        let before = c.get_overview(None, None);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].meter.headline_bucket, Some(3));
        assert_eq!(before[0].final_bucket, None);
        finalize(&mut c, END_MS);
        assert_eq!(c.get_overview(None, None)[0].final_bucket, Some(3));
        assert!(c.get_overview(Some(5), None).is_empty());
    }

    const M_CLOSE: u64 = 5_000;
    const M_RESOLVE: u64 = 9_000;

    fn mk_market(c: &mut Contract, threshold: u64) -> u64 {
        as_user("owner.near", OPEN_MS);
        c.create_market(
            0,
            "Worldwide gross (USD)".into(),
            U64(threshold),
            U64(M_CLOSE),
            U64(M_RESOLVE),
        )
    }

    fn bet_as(c: &mut Contract, market: u64, who: &str, near_milli: u128, side: u8, ts_ms: u64) {
        testing_env!(ctx(who, NearToken::from_millinear(near_milli), ts_ms).build());
        c.bet(market, side);
    }

    fn post(c: &mut Contract, who: &str, value: u64, ts_ms: u64) {
        as_user(who, ts_ms);
        c.post_data_point(0, U64(value), "TMDB".into(), "https://tmdb".into(), "hash".into(), U64(1));
    }

    fn resolve(c: &mut Contract, market: u64, ts_ms: u64) {
        as_user("anyone.near", ts_ms);
        c.resolve_market(market);
    }

    fn mpay(c: &Contract, market: u64, who: &str) -> (String, u128) {
        let p = c.preview_market_claim(market, acct(who)).unwrap();
        (p.state, p.payout.0)
    }

    #[test]
    fn market_pays_winners_from_the_losing_pool() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 1000, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 500, 1, OPEN_MS);
        bet_as(&mut c, m, "chitra.near", 800, 0, OPEN_MS);
        bet_as(&mut c, m, "dev.near", 700, 0, OPEN_MS);
        assert_eq!(c.get_market(m).unwrap().over_pct, 50);

        post(&mut c, "owner.near", 120, M_RESOLVE + 500);
        resolve(&mut c, m, M_RESOLVE + 500);

        let view = c.get_market(m).unwrap();
        assert_eq!((view.state.as_str(), view.outcome), ("resolved", Some(1)));
        assert_eq!(view.resolved_value.map(|v| v.0), Some(120));

        // pool shares round down at 1e-9 precision, so allow a billionth of a NEAR of dust
        let dust = 10_000_000_000_000_000u128; // 1e16 yocto
        let (state, asha) = mpay(&c, m, "asha.near");
        assert_eq!(state, "won");
        assert!(asha <= milli(2000) && milli(2000) - asha < dust);
        let (state, ben) = mpay(&c, m, "ben.near");
        assert_eq!(state, "won");
        assert!(ben <= milli(1000) && milli(1000) - ben < dust);
        assert_eq!(mpay(&c, m, "chitra.near"), ("lost".to_string(), 0));
        let paid: u128 = ["asha.near", "ben.near", "chitra.near", "dev.near"]
            .iter()
            .map(|w| mpay(&c, m, w).1)
            .sum();
        assert!(paid <= milli(3000));
        assert!(milli(3000) - paid < dust * 2);
    }

    #[test]
    fn a_value_equal_to_the_threshold_resolves_under() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 100, 0, OPEN_MS);
        post(&mut c, "owner.near", 100, M_RESOLVE);
        resolve(&mut c, m, M_RESOLVE);
        assert_eq!(c.get_market(m).unwrap().outcome, Some(0));
    }

    #[test]
    fn only_readings_posted_after_the_resolve_time_count() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 100, 0, OPEN_MS);
        post(&mut c, "owner.near", 50, M_RESOLVE - 1_000); // early reading says Under
        post(&mut c, "owner.near", 120, M_RESOLVE + 1_000); // the one that counts says Over
        post(&mut c, "owner.near", 10, M_RESOLVE + 2_000); // later reading is ignored
        resolve(&mut c, m, M_RESOLVE + 2_000);
        assert_eq!(c.get_market(m).unwrap().outcome, Some(1));
    }

    #[test]
    #[should_panic(expected = "Waiting for resolution data")]
    fn resolving_waits_for_a_fresh_reading() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        post(&mut c, "owner.near", 120, M_RESOLVE - 1_000);
        resolve(&mut c, m, M_RESOLVE);
    }

    #[test]
    #[should_panic(expected = "Too early")]
    fn cannot_resolve_before_the_resolve_time() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        resolve(&mut c, m, M_RESOLVE - 1);
    }

    #[test]
    fn market_refunds_everyone_when_nobody_backed_the_winner() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 300, 0, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 200, 0, OPEN_MS);
        post(&mut c, "owner.near", 500, M_RESOLVE);
        resolve(&mut c, m, M_RESOLVE);
        assert_eq!(c.get_market(m).unwrap().state, "void");
        assert_eq!(mpay(&c, m, "asha.near"), ("void".to_string(), milli(300)));
        assert_eq!(mpay(&c, m, "ben.near"), ("void".to_string(), milli(200)));
    }

    #[test]
    fn market_refunds_everyone_if_no_data_ever_arrives() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 300, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 200, 0, OPEN_MS);
        resolve(&mut c, m, M_RESOLVE + FINALIZE_GRACE_MS);
        assert_eq!(c.get_market(m).unwrap().state, "void");
        assert_eq!(mpay(&c, m, "asha.near").1, milli(300));
        as_user("asha.near", M_RESOLVE + FINALIZE_GRACE_MS);
        let _ = c.claim_market(m);
        assert!(c.get_bet(m, acct("asha.near")).unwrap().claimed);
    }

    #[test]
    #[should_panic(expected = "Bet already claimed")]
    fn market_payout_is_claimed_once() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 100, 0, OPEN_MS);
        post(&mut c, "owner.near", 120, M_RESOLVE);
        resolve(&mut c, m, M_RESOLVE);
        as_user("asha.near", M_RESOLVE);
        let _ = c.claim_market(m);
        let _ = c.claim_market(m);
    }

    #[test]
    #[should_panic(expected = "not resolved yet")]
    fn market_cannot_be_claimed_before_it_resolves() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        as_user("asha.near", M_CLOSE + 1);
        let _ = c.claim_market(m);
    }

    #[test]
    fn losing_bettors_can_claim_for_nothing_but_the_bet_is_marked() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        bet_as(&mut c, m, "ben.near", 100, 0, OPEN_MS);
        post(&mut c, "owner.near", 120, M_RESOLVE);
        resolve(&mut c, m, M_RESOLVE);
        as_user("ben.near", M_RESOLVE);
        let _ = c.claim_market(m);
        assert!(c.get_bet(m, acct("ben.near")).unwrap().claimed);
    }

    #[test]
    #[should_panic(expected = "Already bet")]
    fn one_bet_per_account_per_market() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, OPEN_MS);
        bet_as(&mut c, m, "asha.near", 100, 0, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "Betting is closed")]
    fn no_bets_after_the_market_closes() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 1, M_CLOSE);
    }

    #[test]
    #[should_panic(expected = "below the minimum")]
    fn market_bets_respect_the_minimum_stake() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 10, 1, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "Side must be")]
    fn market_side_must_be_zero_or_one() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        bet_as(&mut c, m, "asha.near", 100, 2, OPEN_MS);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_the_owner_creates_markets() {
        let mut c = setup();
        as_user("mallory.near", OPEN_MS);
        c.create_market(0, "Gross".into(), U64(1), U64(1), U64(2));
    }

    #[test]
    #[should_panic(expected = "Only the resolver")]
    fn strangers_cannot_post_data() {
        let mut c = setup();
        post(&mut c, "mallory.near", 999, OPEN_MS);
    }

    #[test]
    fn owner_can_hand_the_data_feed_to_an_agent_account() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.set_resolver(acct("agent.near"));
        post(&mut c, "agent.near", 77, OPEN_MS);
        assert_eq!(c.get_config().resolver.as_str(), "agent.near");
        assert_eq!(c.get_data_points(0).len(), 1);
    }

    #[test]
    fn data_points_are_stamped_with_chain_time_not_agent_time() {
        let mut c = setup();
        post(&mut c, "owner.near", 42, 7_777);
        let dp = &c.get_data_points(0)[0];
        assert_eq!(dp.posted_at_ms.0, 7_777);
        assert_eq!(dp.fetched_at_ms.0, 1);
        assert_eq!((dp.value.0, dp.source.as_str()), (42, "TMDB"));
    }

    #[test]
    fn markets_are_listed_with_state() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        as_user("anyone.near", OPEN_MS);
        assert_eq!(c.get_markets(None, None).len(), 1);
        assert_eq!(c.get_market(m).unwrap().state, "open");
        as_user("anyone.near", M_CLOSE + 1);
        assert_eq!(c.get_market(m).unwrap().state, "closed");
        assert_eq!(c.get_config().market_count, 1);
    }

    fn post_for(c: &mut Contract, movie: u64, who: &str, value: u64, ts_ms: u64) {
        as_user(who, ts_ms);
        c.post_data_point(movie, U64(value), "OMDb".into(), "https://omdb".into(), "hash".into(), U64(1));
    }

    // Movie 0 is "A", a second movie added here is "B".
    fn mk_duel(c: &mut Contract) -> u64 {
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        c.create_duel(
            0,
            1,
            "Domestic gross (USD, OMDb)".into(),
            U64(M_CLOSE),
            U64(M_RESOLVE),
        )
    }

    fn duel_with_bets(c: &mut Contract) -> u64 {
        let d = mk_duel(c);
        bet_as(c, d, "asha.near", 1000, 0, OPEN_MS); // backs A
        bet_as(c, d, "ben.near", 500, 0, OPEN_MS); // backs A
        bet_as(c, d, "chitra.near", 800, 1, OPEN_MS); // backs B
        bet_as(c, d, "dev.near", 700, 1, OPEN_MS); // backs B
        d
    }

    #[test]
    fn duel_pays_the_side_whose_movie_ends_higher() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        assert_eq!(c.get_market(d).unwrap().kind, 1);
        assert_eq!(c.get_market(d).unwrap().movie_b, Some(1));

        post_for(&mut c, 0, "owner.near", 300, M_RESOLVE + 100);
        post_for(&mut c, 1, "owner.near", 200, M_RESOLVE + 100);
        resolve(&mut c, d, M_RESOLVE + 200);

        let v = c.get_market(d).unwrap();
        assert_eq!((v.state.as_str(), v.outcome), ("resolved", Some(0)));
        assert_eq!(v.resolved_value.map(|x| x.0), Some(300));
        assert_eq!(v.resolved_value_b.map(|x| x.0), Some(200));

        let dust = 10_000_000_000_000_000u128;
        let (state, asha) = mpay(&c, d, "asha.near");
        assert_eq!(state, "won");
        assert!(asha <= milli(2000) && milli(2000) - asha < dust);
        assert_eq!(mpay(&c, d, "chitra.near"), ("lost".to_string(), 0));
        let paid: u128 = ["asha.near", "ben.near", "chitra.near", "dev.near"]
            .iter()
            .map(|w| mpay(&c, d, w).1)
            .sum();
        assert!(paid <= milli(3000) && milli(3000) - paid < dust * 2);
    }

    #[test]
    fn duel_pays_movie_b_when_it_ends_higher() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        post_for(&mut c, 0, "owner.near", 100, M_RESOLVE);
        post_for(&mut c, 1, "owner.near", 400, M_RESOLVE);
        resolve(&mut c, d, M_RESOLVE);
        assert_eq!(c.get_market(d).unwrap().outcome, Some(1));
        assert_eq!(mpay(&c, d, "asha.near"), ("lost".to_string(), 0));
        let (state, chitra) = mpay(&c, d, "chitra.near");
        assert_eq!(state, "won");
        // chitra staked 0.8 of the winning 1.5 and shares the losing 1.5
        assert!(chitra > milli(1500) && chitra < milli(1600));
    }

    #[test]
    fn duel_tie_voids_and_refunds_everyone() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        post_for(&mut c, 0, "owner.near", 250, M_RESOLVE);
        post_for(&mut c, 1, "owner.near", 250, M_RESOLVE);
        resolve(&mut c, d, M_RESOLVE);
        assert_eq!(c.get_market(d).unwrap().state, "void");
        assert_eq!(mpay(&c, d, "asha.near"), ("void".to_string(), milli(1000)));
        assert_eq!(mpay(&c, d, "dev.near"), ("void".to_string(), milli(700)));
    }

    #[test]
    #[should_panic(expected = "Waiting for resolution data")]
    fn duel_waits_when_only_one_movie_has_a_fresh_reading() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        post_for(&mut c, 0, "owner.near", 300, M_RESOLVE + 100);
        resolve(&mut c, d, M_RESOLVE + 200);
    }

    #[test]
    fn duel_ignores_readings_posted_before_the_resolve_time() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        // early readings say B leads, the readings that count say A leads
        post_for(&mut c, 0, "owner.near", 100, M_RESOLVE - 1_000);
        post_for(&mut c, 1, "owner.near", 900, M_RESOLVE - 1_000);
        post_for(&mut c, 0, "owner.near", 300, M_RESOLVE + 100);
        post_for(&mut c, 1, "owner.near", 200, M_RESOLVE + 100);
        // later readings are ignored too
        post_for(&mut c, 1, "owner.near", 999, M_RESOLVE + 5_000);
        resolve(&mut c, d, M_RESOLVE + 5_000);
        let v = c.get_market(d).unwrap();
        assert_eq!(v.outcome, Some(0));
        assert_eq!(v.resolved_value_b.map(|x| x.0), Some(200));
    }

    #[test]
    fn duel_voids_after_grace_when_no_data_arrives() {
        let mut c = setup();
        let d = duel_with_bets(&mut c);
        post_for(&mut c, 0, "owner.near", 300, M_RESOLVE + 100); // only one side ever reported
        resolve(&mut c, d, M_RESOLVE + FINALIZE_GRACE_MS);
        assert_eq!(c.get_market(d).unwrap().state, "void");
        assert_eq!(mpay(&c, d, "chitra.near"), ("void".to_string(), milli(800)));
    }

    #[test]
    fn duel_voids_when_nobody_backed_the_winning_movie() {
        let mut c = setup();
        let d = mk_duel(&mut c);
        bet_as(&mut c, d, "asha.near", 300, 1, OPEN_MS); // everyone backs B
        bet_as(&mut c, d, "ben.near", 200, 1, OPEN_MS);
        post_for(&mut c, 0, "owner.near", 500, M_RESOLVE);
        post_for(&mut c, 1, "owner.near", 100, M_RESOLVE); // A wins, nobody backed A
        resolve(&mut c, d, M_RESOLVE);
        assert_eq!(c.get_market(d).unwrap().state, "void");
        assert_eq!(mpay(&c, d, "asha.near").1, milli(300));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_the_owner_creates_duels() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        as_user("mallory.near", OPEN_MS);
        c.create_duel(0, 1, "Gross".into(), U64(1), U64(2));
    }

    #[test]
    #[should_panic(expected = "two different movies")]
    fn duel_needs_two_different_movies() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.create_duel(0, 0, "Gross".into(), U64(1), U64(2));
    }

    #[test]
    #[should_panic(expected = "Movie not found")]
    fn duel_rejects_an_unknown_movie() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.create_duel(0, 7, "Gross".into(), U64(1), U64(2));
    }

    #[test]
    #[should_panic(expected = "close before resolution")]
    fn duel_must_close_before_it_resolves() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        c.create_duel(0, 1, "Gross".into(), U64(9), U64(2));
    }

    #[test]
    fn threshold_markets_report_kind_zero() {
        let mut c = setup();
        let m = mk_market(&mut c, 100);
        as_user("anyone.near", OPEN_MS);
        let v = c.get_market(m).unwrap();
        assert_eq!((v.kind, v.movie_b, v.resolved_value_b.is_none()), (0, None, true));
    }

    fn comment_as(c: &mut Contract, who: &str, text: &str, ts_ms: u64) {
        as_user(who, ts_ms);
        c.post_comment(0, text.to_string());
    }

    #[test]
    fn comments_are_listed_newest_first() {
        let mut c = setup();
        comment_as(&mut c, "alice.near", "Loved it", 1_000);
        comment_as(&mut c, "bob.near", "Not for me", 2_000);
        comment_as(&mut c, "carol.near", "Rewatching tonight", 3_000);

        let all = c.get_comments(0, None, None);
        assert_eq!(c.get_comment_count(0), 3);
        assert_eq!(all[0].author.as_str(), "carol.near");
        assert_eq!(all[2].author.as_str(), "alice.near");
        assert_eq!(all[1].text, "Not for me");
        assert_eq!(all[1].ts_ms.0, 2_000);

        let page = c.get_comments(0, Some(1), Some(1));
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].author.as_str(), "bob.near");
    }

    #[test]
    fn posting_again_replaces_your_earlier_comment() {
        let mut c = setup();
        comment_as(&mut c, "alice.near", "First thoughts", 1_000);
        comment_as(&mut c, "bob.near", "Agreed", 2_000);
        comment_as(&mut c, "alice.near", "Changed my mind", 3_000);

        let all = c.get_comments(0, None, None);
        assert_eq!(c.get_comment_count(0), 2);
        assert_eq!(all[0].author.as_str(), "alice.near");
        assert_eq!(all[0].text, "Changed my mind");
    }

    #[test]
    fn comment_text_is_trimmed_and_length_checked_in_characters() {
        let mut c = setup();
        comment_as(&mut c, "alice.near", "   spaced out   ", 1_000);
        assert_eq!(c.get_comments(0, None, None)[0].text, "spaced out");

        // 280 emoji are 280 characters even though they are far more bytes
        comment_as(&mut c, "bob.near", &"🎬".repeat(MAX_COMMENT_CHARS), 2_000);
        assert_eq!(c.get_comment_count(0), 2);
    }

    #[test]
    #[should_panic(expected = "too long")]
    fn comments_over_the_limit_are_rejected() {
        let mut c = setup();
        comment_as(&mut c, "alice.near", &"a".repeat(MAX_COMMENT_CHARS + 1), 1_000);
    }

    #[test]
    #[should_panic(expected = "cannot be empty")]
    fn blank_comments_are_rejected() {
        let mut c = setup();
        comment_as(&mut c, "alice.near", "   \n  ", 1_000);
    }

    #[test]
    #[should_panic(expected = "Movie not found")]
    fn comments_need_a_real_movie() {
        let mut c = setup();
        as_user("alice.near", 1_000);
        c.post_comment(99, "Hello".to_string());
    }

    #[test]
    fn only_the_newest_comments_are_kept() {
        let mut c = setup();
        for i in 0..(MAX_COMMENTS_PER_MOVIE + 5) {
            comment_as(&mut c, &format!("user{i}.near"), &format!("comment {i}"), 1_000 + i as u64);
        }
        assert_eq!(c.get_comment_count(0), MAX_COMMENTS_PER_MOVIE as u64);
        let all = c.get_comments(0, None, None);
        assert_eq!(all[0].text, format!("comment {}", MAX_COMMENTS_PER_MOVIE + 4));
        assert_eq!(all.last().unwrap().text, "comment 5");
    }

    #[test]
    fn comments_are_kept_per_movie() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        comment_as(&mut c, "alice.near", "On movie zero", 1_000);
        as_user("alice.near", 2_000);
        c.post_comment(1, "On movie one".to_string());
        assert_eq!(c.get_comments(0, None, None)[0].text, "On movie zero");
        assert_eq!(c.get_comments(1, None, None)[0].text, "On movie one");
        assert_eq!(c.get_comment_count(5), 0);
    }

    #[test]
    fn movies_are_listed() {
        let mut c = setup();
        as_user("owner.near", OPEN_MS);
        c.add_movie(2, "Coraline".into(), String::new(), U64(0), U64(END_MS));
        let all = c.get_movies(None, None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].title, "Coraline");
        assert_eq!(c.get_movies(Some(1), Some(5)).len(), 1);
    }
}
