//! Component test (task A-mustard-rust, candidate-a): the repair sweep over a
//! PAUSED room is a pure resend. apply_snapshot.lua must return the identical
//! timeline tuple on every call and change neither the room hash nor the
//! command-log length. Needs a Redis: REDIS_URL=redis://localhost:6380
//! (docker compose -f docker-compose.lab.yml up -d redis); skips otherwise.
//! LUA_DIR defaults to ../video-sync-backend/src/sync/lua.
use redis::AsyncCommands;
use std::collections::HashMap;

fn tuple(raw: &str) -> (i64, String, bool, f64, f64) {
    let v: serde_json::Value = serde_json::from_str(raw).expect("lua returns json");
    (
        v["seq"].as_i64().unwrap(),
        v["storeEpoch"].as_str().unwrap().to_string(),
        v["isPlaying"].as_bool().unwrap(),
        v["mediaTime"].as_f64().unwrap(),
        v["stampedAt"].as_f64().unwrap(),
    )
}

#[tokio::test]
async fn paused_sweep_returns_identical_tuple_and_changes_no_state() {
    let url = match std::env::var("REDIS_URL") {
        Ok(u) => u,
        Err(_) => {
            eprintln!("skipped: REDIS_URL unset");
            return;
        }
    };
    let lua_dir = std::env::var("LUA_DIR").unwrap_or_else(|_| "../video-sync-backend/src/sync/lua".into());
    let read = |n: &str| std::fs::read_to_string(format!("{lua_dir}/{n}")).expect("lua file");
    let common = read("common.lua");
    let init = redis::Script::new(&(common.clone() + &read("init.lua")));
    let control = redis::Script::new(&(common.clone() + &read("apply_control.lua")));
    let snapshot = redis::Script::new(&(common + &read("apply_snapshot.lua")));
    let client = redis::Client::open(url).unwrap();
    let mut c = client.get_multiplexed_async_connection().await.expect("redis");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let room = format!("pausedsweeptest{now}");
    let tl_key = format!("room:{room}:tl");
    let log_key = format!("room:{room}:log");
    let cmd_key = |id: &str| format!("room:{room}:cmd:{id}");

    // birth (paused at 0), play, pause: a paused room with seq 2 and a log of 3 entries
    let _: String = init.key(&tl_key).key(&log_key).arg("").arg("0").invoke_async(&mut c).await.unwrap();
    for (intent, id, pos) in [("play", "t-play", "10"), ("pause", "t-pause", "12.5")] {
        let _: String = control
            .key(&tl_key).key(&cmd_key(id)).key(&log_key)
            .arg(intent).arg(pos).arg("test").arg(id).arg(900000)
            .invoke_async(&mut c).await.unwrap();
    }
    let hash_before: HashMap<String, String> = c.hgetall(&tl_key).await.unwrap();
    let len_before: i64 = c.xlen(&log_key).await.unwrap();
    assert_eq!(hash_before["isPlaying"], "0");
    assert_eq!(len_before, 3);

    // two sweeps over the paused room, in two different 10 s windows is not
    // required: the paused arm never consults the window
    let r1: String = snapshot.key(&tl_key).key(&log_key).arg(10000).invoke_async(&mut c).await.unwrap();
    let r2: String = snapshot.key(&tl_key).key(&log_key).arg(10000).invoke_async(&mut c).await.unwrap();
    let t1 = tuple(&r1);
    let t2 = tuple(&r2);
    assert_eq!(t1, t2, "paused sweep must return the identical tuple every time");
    assert!(!t1.2, "paused sweep must report isPlaying = false");
    assert_eq!(t1.0.to_string(), hash_before["seq"], "no seq bump");
    assert_eq!(t1.1, hash_before["storeEpoch"]);
    assert_eq!(t1.3.to_string(), hash_before["mediaTime"], "position unchanged");
    assert_eq!(t1.4.to_string(), hash_before["stampedAt"], "stamp unchanged");

    let hash_after: HashMap<String, String> = c.hgetall(&tl_key).await.unwrap();
    let len_after: i64 = c.xlen(&log_key).await.unwrap();
    assert_eq!(hash_after, hash_before, "room hash must be untouched by a paused sweep");
    assert_eq!(len_after, len_before, "no log entry for a paused sweep");

    let _: () = c.del(&[tl_key, log_key, cmd_key("t-play"), cmd_key("t-pause")]).await.unwrap();
}
