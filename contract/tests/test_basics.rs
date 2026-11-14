use near_api::{AccountId, NearGas, NearToken};
use near_sdk::serde_json::json;

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Meter {
    pub counts: [u32; 4],
    pub total_votes: u32,
    pub headline_bucket: Option<u8>,
    pub headline_pct: u8,
}

#[tokio::test]
async fn test_vote_meter_and_bond_flow() -> testresult::TestResult<()> {
    let contract_wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let contract_wasm = std::fs::read(contract_wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);

    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let contract = create_subaccount(&sandbox, "contract.sandbox")
        .await?
        .as_contract();

    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;

    let now_ms = near_api::Chain::block()
        .fetch_from(&net)
        .await?
        .header
        .timestamp_nanosec
        .parse::<u64>()?
        / 1_000_000;
    let vote_end_ms = now_ms + 60_000;

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(contract_wasm)
        .with_init_call(
            "init",
            json!({
                "owner": owner.account_id(),
                "min_stake": NearToken::from_millinear(100).as_yoctonear().to_string(),
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Non-owner cannot add a movie
    contract
        .call_function(
            "add_movie",
            json!({"tmdb_id": 1, "title": "Rockstar", "poster_url": "", "release_ts_ms": "0", "vote_end_ts_ms": vote_end_ms.to_string()}),
        )
        .transaction()
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Owner adds the movie (id 0)
    contract
        .call_function(
            "add_movie",
            json!({"tmdb_id": 1, "title": "Rockstar", "poster_url": "", "release_ts_ms": "0", "vote_end_ts_ms": vote_end_ms.to_string()}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Alice and Bob vote with different stakes
    contract
        .call_function("vote", json!({"movie_id": 0, "bucket": 3}))
        .transaction()
        .deposit(NearToken::from_near(1))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("vote", json!({"movie_id": 0, "bucket": 2}))
        .transaction()
        .deposit(NearToken::from_millinear(500))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Double vote and under-minimum stake are rejected
    contract
        .call_function("vote", json!({"movie_id": 0, "bucket": 1}))
        .transaction()
        .deposit(NearToken::from_near(1))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    let meter: Meter = contract
        .call_function("get_meter", json!({"movie_id": 0}))
        .read_only()
        .fetch_from(&net)
        .await?
        .data;
    assert_eq!(meter.counts, [0, 0, 1, 1]);
    assert_eq!(meter.total_votes, 2);
    assert_eq!(meter.headline_bucket, Some(3));
    assert_eq!(meter.headline_pct, 50);

    // Bond cannot be claimed while the window is open
    contract
        .call_function("claim_bond", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    let alice_before = alice.tokens().near_balance().fetch_from(&net).await?.total;
    let bob_before = bob.tokens().near_balance().fetch_from(&net).await?.total;

    sandbox.fast_forward(200).await?;

    // After close, claiming still waits for the verdict
    contract
        .call_function("claim_bond", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Anyone can finalize (bob does); Perfection wins the 1-1 weight tie
    contract
        .call_function("finalize_meter", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Winner alice staked 1.0 and gets 1.0 + 20% of bob's 0.5 = 1.1 NEAR back
    contract
        .call_function("claim_bond", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let alice_after = alice.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(alice_after > alice_before.saturating_add(NearToken::from_millinear(1090)));
    assert!(alice_after < alice_before.saturating_add(NearToken::from_millinear(1100)));

    // Loser bob staked 0.5, loses 20% of it, and gets 0.4 NEAR back
    contract
        .call_function("claim_bond", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let bob_after = bob.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(bob_after > bob_before.saturating_add(NearToken::from_millinear(390)));
    assert!(bob_after < bob_before.saturating_add(NearToken::from_millinear(400)));

    // Second claim fails
    contract
        .call_function("claim_bond", json!({"movie_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Voting after the window closes fails
    contract
        .call_function("vote", json!({"movie_id": 0, "bucket": 0}))
        .transaction()
        .deposit(NearToken::from_near(1))
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    Ok(())
}

#[tokio::test]
async fn test_box_office_market_flow() -> testresult::TestResult<()> {
    let contract_wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let contract_wasm = std::fs::read(contract_wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);

    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let contract = create_subaccount(&sandbox, "contract.sandbox")
        .await?
        .as_contract();
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;

    let now_ms = near_api::Chain::block()
        .fetch_from(&net)
        .await?
        .header
        .timestamp_nanosec
        .parse::<u64>()?
        / 1_000_000;

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(contract_wasm)
        .with_init_call(
            "init",
            json!({
                "owner": owner.account_id(),
                "min_stake": NearToken::from_millinear(100).as_yoctonear().to_string(),
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function(
            "add_movie",
            json!({"tmdb_id": 1, "title": "Godzilla", "poster_url": "", "release_ts_ms": "0", "vote_end_ts_ms": (now_ms + 600_000).to_string()}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Betting closes in 20s, resolution opens after 40s
    contract
        .call_function(
            "create_market",
            json!({"movie_id": 0, "metric": "Worldwide gross (USD)", "threshold": "100",
                   "closes_at_ms": (now_ms + 20_000).to_string(), "resolves_at_ms": (now_ms + 40_000).to_string()}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // alice backs Over with 1.0 NEAR, bob backs Under with 0.5 NEAR
    contract
        .call_function("bet", json!({"market_id": 0, "side": 1}))
        .transaction()
        .deposit(NearToken::from_near(1))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("bet", json!({"market_id": 0, "side": 0}))
        .transaction()
        .deposit(NearToken::from_millinear(500))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Resolving too early fails, and so does a data point from a stranger
    contract
        .call_function("resolve_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();
    contract
        .call_function(
            "post_data_point",
            json!({"movie_id": 0, "value": "999", "source": "TMDB", "source_url": "https://x", "evidence_hash": "h", "fetched_at_ms": "1"}),
        )
        .transaction()
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    sandbox.fast_forward(400).await?;

    // Betting is closed now
    contract
        .call_function("bet", json!({"market_id": 0, "side": 0}))
        .transaction()
        .deposit(NearToken::from_millinear(500))
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // The resolver posts the reading (120 > 100, so Over wins) and anyone resolves
    contract
        .call_function(
            "post_data_point",
            json!({"movie_id": 0, "value": "120", "source": "TMDB", "source_url": "https://x", "evidence_hash": "h", "fetched_at_ms": "1"}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("resolve_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // alice wins her 1.0 back plus bob's 0.5
    let alice_before = alice.tokens().near_balance().fetch_from(&net).await?.total;
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let alice_after = alice.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(alice_after > alice_before.saturating_add(NearToken::from_millinear(1490)));
    assert!(alice_after < alice_before.saturating_add(NearToken::from_millinear(1500)));

    // bob lost, so his claim pays nothing, and claiming twice fails
    let bob_before = bob.tokens().near_balance().fetch_from(&net).await?.total;
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let bob_after = bob.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(bob_after <= bob_before);
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    Ok(())
}

#[tokio::test]
async fn test_head_to_head_duel_flow() -> testresult::TestResult<()> {
    let contract_wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let contract_wasm = std::fs::read(contract_wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);

    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let contract = create_subaccount(&sandbox, "contract.sandbox")
        .await?
        .as_contract();
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;

    let now_ms = near_api::Chain::block()
        .fetch_from(&net)
        .await?
        .header
        .timestamp_nanosec
        .parse::<u64>()?
        / 1_000_000;

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(contract_wasm)
        .with_init_call(
            "init",
            json!({
                "owner": owner.account_id(),
                "min_stake": NearToken::from_millinear(100).as_yoctonear().to_string(),
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    for (tmdb_id, title) in [(1, "Movie A"), (2, "Movie B")] {
        contract
            .call_function(
                "add_movie",
                json!({"tmdb_id": tmdb_id, "title": title, "poster_url": "", "release_ts_ms": "0", "vote_end_ts_ms": (now_ms + 600_000).to_string()}),
            )
            .transaction()
            .with_signer(owner.account_id().clone(), signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }

    // A non-owner cannot create a duel, and a duel needs two different movies
    contract
        .call_function(
            "create_duel",
            json!({"movie_a": 0, "movie_b": 1, "metric": "Domestic gross (USD, OMDb)",
                   "closes_at_ms": (now_ms + 20_000).to_string(), "resolves_at_ms": (now_ms + 40_000).to_string()}),
        )
        .transaction()
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();
    contract
        .call_function(
            "create_duel",
            json!({"movie_a": 0, "movie_b": 0, "metric": "Domestic gross (USD, OMDb)",
                   "closes_at_ms": (now_ms + 20_000).to_string(), "resolves_at_ms": (now_ms + 40_000).to_string()}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Betting closes in 20s, resolution opens after 40s
    contract
        .call_function(
            "create_duel",
            json!({"movie_a": 0, "movie_b": 1, "metric": "Domestic gross (USD, OMDb)",
                   "closes_at_ms": (now_ms + 20_000).to_string(), "resolves_at_ms": (now_ms + 40_000).to_string()}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // alice backs movie A with 1.0 NEAR, bob backs movie B with 0.5 NEAR
    contract
        .call_function("bet", json!({"market_id": 0, "side": 0}))
        .transaction()
        .deposit(NearToken::from_near(1))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("bet", json!({"market_id": 0, "side": 1}))
        .transaction()
        .deposit(NearToken::from_millinear(500))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    sandbox.fast_forward(400).await?;

    // Only movie A has a fresh reading so far, so resolving must wait
    contract
        .call_function(
            "post_data_point",
            json!({"movie_id": 0, "value": "300", "source": "OMDb", "source_url": "https://x", "evidence_hash": "h", "fetched_at_ms": "1"}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("resolve_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Movie B reports a lower figure, so movie A leads and anyone can resolve
    contract
        .call_function(
            "post_data_point",
            json!({"movie_id": 1, "value": "200", "source": "OMDb", "source_url": "https://x", "evidence_hash": "h", "fetched_at_ms": "1"}),
        )
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    contract
        .call_function("resolve_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // alice wins her 1.0 back plus bob's 0.5
    let alice_before = alice.tokens().near_balance().fetch_from(&net).await?.total;
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let alice_after = alice.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(alice_after > alice_before.saturating_add(NearToken::from_millinear(1490)));
    assert!(alice_after < alice_before.saturating_add(NearToken::from_millinear(1500)));

    // bob lost, so his claim pays nothing, and claiming twice fails
    let bob_before = bob.tokens().near_balance().fetch_from(&net).await?.total;
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let bob_after = bob.tokens().near_balance().fetch_from(&net).await?.total;
    assert!(bob_after <= bob_before);
    contract
        .call_function("claim_market", json!({"market_id": 0}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    Ok(())
}

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(account_id.clone())
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}
