// ベンチマーク用の最小の待受け。
//
// aichat wait と同じように long-poll でぶら下がるだけ。**検証も表示も持たない**。
// 待受け中のメモリを他の実装（C# ・ node ・ bun ・ Rust）と並べて測るためだけに作った。
//
// 製品として使うものではない。ID もルームも検証せず、繋がらなければ黙って終わる。
//
// 外部モジュールを使わない。標準の net/http だけで足りる。
//
//	go build -o aichat-go.exe main.go
//	aichat-go.exe :myid: -p <ポート> -r sandbox-bench -a <トークン> --wait-sec 600
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// 1 回の long-poll の上限。サーバー側と同じ値にしておく
const pollWaitSec = 240

func main() {
	port := "8787"
	id := ""
	room := "public"
	token := ""
	total := 600

	args := os.Args

	// 起動の速さを他の実装と同じ土俵で測るためだけに置く。使い方は出さない
	for _, a := range args[1:] {
		if a == "--help" || a == "-h" {
			fmt.Println("ベンチマーク用の最小の待受け。wait しか持たない")
			return
		}
	}

	for i := 1; i < len(args); i++ {
		a := args[i]
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch a {
		case "-p", "--port":
			port = next
			i++
		case "-r", "--room":
			room = next
			i++
		case "-a", "--access-token":
			token = next
			i++
		case "--wait-sec":
			if n, err := strconv.Atoi(next); err == nil {
				total = n
			}
			i++
		default:
			// 名乗る ID は :id: の形で来る
			if len(a) > 2 && strings.HasPrefix(a, ":") && strings.HasSuffix(a, ":") {
				id = a[1 : len(a)-1]
			}
		}
	}

	// 読んだ位置を立てる。初めての接続だと、これが無いと最初の poll が全件を返す
	_, _ = poll(port, id, room, token, 0)

	fmt.Printf("pid %d で待受け中（最大 %d 秒、ルーム %s）\n", os.Getpid(), total, room)

	left := total
	for left > 0 {
		w := pollWaitSec
		if left < w {
			w = left
		}
		body, err := poll(port, id, room, token, w)
		if err != nil {
			fmt.Fprintf(os.Stderr, "繋がりません: %v\n", err)
			return
		}
		// 新着があれば出して終わる。無ければ待ち直す
		if strings.Contains(body, `"messages":[{`) {
			fmt.Println("新着あり")
			return
		}
		left -= w
	}
	fmt.Println("新着なし")
}

// long-poll を 1 回叩き、レスポンス本文を返す。
func poll(port, id, room, token string, wait int) (string, error) {
	q := url.Values{}
	q.Set("connector_id", id)
	q.Set("room_id", room)
	q.Set("wait", strconv.Itoa(wait))
	q.Set("exclude", "join,leave")
	q.Set("access_token", token)

	u := fmt.Sprintf("http://127.0.0.1:%s/api/poll?%s", port, q.Encode())

	// long-poll なので、待つ長さより十分に長い上限を置く
	client := &http.Client{Timeout: time.Duration(wait+60) * time.Second}
	res, err := client.Get(u)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	b, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
