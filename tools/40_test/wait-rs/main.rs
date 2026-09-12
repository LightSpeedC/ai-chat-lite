//! ベンチマーク用の最小の待受け。
//!
//! `aichat wait` と同じように long-poll でぶら下がるだけ。**検証も表示も持たない**。
//! 待受け中のメモリを 3 実装（C# ・ node ・ bun）と並べて測るためだけに作った。
//!
//! 製品として使うものではない。ID もルームも検証せず、繋がらなければ黙って終わる。
//!
//! 外部クレートを使わない。HTTP/1.1 を手で書き、`Connection: close` を付けて
//! 「接続が閉じるまで読む」形にしている。長さの解釈が要らず、実装が短くなる。
//!
//!   rustc -O main.rs -o wait-rs.exe
//!   wait-rs.exe :myid: -p <ポート> -r sandbox-bench -a <トークン> --wait-sec 600

use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;

/// 1 回の long-poll の上限。サーバー側と同じ値にしておく
const POLL_WAIT_SEC: u64 = 240;

fn main() {
    let mut port = String::from("8787");
    let mut id = String::new();
    let mut room = String::from("public");
    let mut token = String::new();
    let mut total: u64 = 600;

    let args: Vec<String> = env::args().collect();

    // 起動の速さを他の実装と同じ土俵で測るためだけに置く。使い方は出さない
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("ベンチマーク用の最小の待受け。wait しか持たない");
        return;
    }

    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).cloned().unwrap_or_default();
        match a {
            "-p" | "--port" => {
                port = next;
                i += 2;
            }
            "-r" | "--room" => {
                room = next;
                i += 2;
            }
            "-a" | "--access-token" => {
                token = next;
                i += 2;
            }
            "--wait-sec" => {
                total = next.parse().unwrap_or(600);
                i += 2;
            }
            s => {
                // 名乗る ID は :id: の形で来る
                if s.len() > 2 && s.starts_with(':') && s.ends_with(':') {
                    id = s[1..s.len() - 1].to_string();
                }
                i += 1;
            }
        }
    }

    // 読んだ位置を立てる。初めての接続だと、これが無いと最初の poll が全件を返す
    let _ = poll(&port, &id, &room, &token, 0);

    println!("pid {} で待受け中（最大 {} 秒、ルーム {}）", std::process::id(), total, room);

    let mut left = total;
    while left > 0 {
        let w = if left > POLL_WAIT_SEC { POLL_WAIT_SEC } else { left };
        match poll(&port, &id, &room, &token, w) {
            Ok(body) => {
                // 新着があれば出して終わる。無ければ待ち直す
                if body.contains("\"messages\":[{") {
                    println!("新着あり");
                    return;
                }
            }
            Err(e) => {
                eprintln!("繋がりません: {}", e);
                return;
            }
        }
        left -= w;
    }
    println!("新着なし");
}

/// long-poll を 1 回叩き、レスポンス全体を返す。
fn poll(port: &str, id: &str, room: &str, token: &str, wait: u64) -> std::io::Result<String> {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))?;

    let path = format!(
        "/api/poll?connector_id={}&room_id={}&wait={}&exclude=join,leave&access_token={}",
        id, room, wait, token
    );
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
        path, port
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
