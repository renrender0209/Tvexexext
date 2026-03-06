# googlevideo-api

YouTube動画のIDまたはURLから、**googlevideo.com の直接ストリームURL** を返すREST APIです。  
[Invidious](https://invidious.io/) / [Piped](https://github.com/TeamPiped/Piped) の公開インスタンスを **大量に並列利用** し、最速で応答したものの結果を返します。

## デプロイ (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. このリポジトリを Fork または Clone
2. [Render](https://render.com) にログイン → **New → Web Service**
3. リポジトリを接続、`render.yaml` が自動検出されます
4. **Deploy** を押すだけ 🚀

## エンドポイント

### `GET /resolve`

| パラメータ | 説明 | デフォルト |
|---|---|---|
| `url` | YouTube URL または 11文字の動画ID | 必須 |
| `quality` | `best` / `1080p` / `720p` / `480p` / `360p` / `240p` / `144p` / `audio` | `best` |
| `all` | `true` にすると全ストリーム一覧を返す | `false` |

```
GET /resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
GET /resolve?url=dQw4w9WgXcQ&quality=720p
GET /resolve/dQw4w9WgXcQ
GET /resolve/dQw4w9WgXcQ?quality=audio
GET /resolve/dQw4w9WgXcQ?all=true
```

### レスポンス例 (`all=false`, default)

```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "duration": 213,
  "thumbnailUrl": "https://...",
  "uploader": "Rick Astley",
  "source": "https://pipedapi.kavin.rocks",
  "sourceType": "piped",
  "latencyMs": 342,
  "quality": "720p",
  "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
  "audioUrl": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
  "hls": null,
  "dash": null,
  "mimeType": "video/mp4",
  "codec": "avc1.64001f"
}
```

### `GET /health`

Renderのヘルスチェック用。

### `GET /stats`

全インスタンスの成功率・レイテンシ等の統計情報を返します。

## 仕組み

```
リクエスト
    │
    ▼
extractVideoId()  ← YouTube URL / ID を正規化
    │
    ▼
instanceManager.getAllInstances()
    ├─ Piped インスタンス (15+) ──┐
    └─ Invidious インスタンス (24+) ┘  ← スコア順で並列リクエスト (最大6並列)
                                            │
                                    最初に成功したものを返す
                                    他はキャンセル (AbortController)
                                            │
                                    recordSuccess() / recordFailure()
                                    → 成功率・レイテンシでスコアリング
                                    → 連続失敗インスタンスは10分間無効化
```

- **動的インスタンスリスト更新**: `api.invidious.io` から30分毎に最新リストを取得
- **フォールバック**: 静的リスト(39インスタンス)がデフォルトで利用可能
- **Rate limit**: 60リクエスト/分/IP

## ローカル開発

```bash
npm install
npm run dev  # nodemon で自動リロード
# または
npm start
```

サーバーは `http://localhost:3000` で起動します。

## ライセンス

MIT
