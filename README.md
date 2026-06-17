# Person Intelligence Search Platform

人物に関する多様な情報源（ニュース、SNS、プロフィール、手入力など）を取り込み、人物単位に正規化・構造化・拡張し、自然文で検索できる、人物インテリジェンス基盤です。

```text
ソース登録 → 処理パイプライン（正規化 / 人物抽出 / リンキング / 文脈抽出 /
カスタムフィールド抽出 / 要約 / embedding / 検索インデックス）
→ 構造化 + ベクトル + 全文（任意）のハイブリッド検索 → 根拠つき検索結果
```

## 特徴

- **人物中心の知識ベース** — 人物・別名・プロフィール・SNSアカウント/メトリクス・出典つきコンテキスト・要約
- **出典に裏付けられたデータ** — 検索結果には matched_reasons と evidence（根拠コンテキスト）が付きます
- **ユーザー定義の型付きフィールド（typed EAV）** — ドメイン固有項目をCoreに入れず拡張。フィルタ・抽出・埋め込み対象を宣言的に制御
- **ハイブリッド検索** — 構造化フィルタ + pgvector ベクトル検索 + PGroonga 日本語全文検索（導入時のみ）をスコア統合
- **自然文 → Search DSL** — LLMはクエリ計画・抽出・要約のみに利用し、検索結果そのものは常にDBから返します（ハルシネーション防止）
- **LLMプロバイダ抽象化** — OpenAI（主対応）/ Anthropic / OpenAI互換エンドポイント。モデルは利用者が明示指定
- **PostgreSQLが唯一のSystem of Record** — 開発時は組み込みPostgres（PGlite + pgvector）で、本番と同一のSQLパスを外部DBなしで実行

## 必要環境

- Node.js **22.18以上**（TypeScriptをビルドなしで直接実行します）
- 本番相当の構成には Docker（PostgreSQL + pgvector + PGroonga）

## クイックスタート（組み込みDB・外部DB不要）

```bash
npm install
cp .env.example .env
# .env に以下の3つを設定（必須）:
#   OPENAI_API_KEY=sk-...
#   EMBEDDING_MODEL=<利用するOpenAIのembeddingモデル名>
#   LLM_MODEL=<利用するOpenAIのモデル名>
npm start              # http://localhost:3000 （PGlite + インラインWorker）
```

クエリ解析・人物/文脈/フィールド抽出・要約・ベクトル検索のすべてが設定したLLM/embeddingモデルで動きます。モデル名にデフォルトはありません（古いモデルへ暗黙に固定しないため）。`EMBEDDING_DIMENSION`（既定256）は指定するembeddingモデルが対応している次元にしてください。

ブラウザで `http://localhost:3000` を開き、右上の「サンプル投入」→ 検索タブで
「Instagramフォロワー100万人以上で、環境保全の文脈で最近話題になっている人物」を検索してください。

デモデータをCLIから投入する場合:

```bash
npm run seed
```

## Docker（PostgreSQL + pgvector + PGroonga + API + Worker）

```bash
docker compose up --build
# http://localhost:3000
```

| サービス | 内容 |
| --- | --- |
| `db` | PostgreSQL 16 + pgvector + PGroonga（[docker/db.Dockerfile](docker/db.Dockerfile)） |
| `api` | REST API + 管理コンソール |
| `worker` | 処理ジョブのポーリングWorker（`FOR UPDATE SKIP LOCKED`、複数台可） |

マイグレーションは起動時に自動適用されます。PGroongaが無い環境では全文検索だけが無効になり、構造化+ベクトル検索で動作します（capability detection）。

## 構成（環境変数）

[.env.example](.env.example) を `.env` にコピーして調整します。主なもの:

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | **必須** | LLMとembeddingの両方に使用（個別に上書き可） |
| `LLM_MODEL` | **必須** | クエリ解析・抽出・要約に使うモデル名。デフォルトなし |
| `EMBEDDING_MODEL` | **必須** | ベクトル検索に使うembeddingモデル名。デフォルトなし |
| `EMBEDDING_DIMENSION` | `256` | ベクトル次元。**初回マイグレーション時に固定**（変更はDB再構築+`npm run reembed`が必要） |
| `LLM_PROVIDER` | `openai` | `openai` / `anthropic`（ANTHROPIC_API_KEYのみ設定時は自動でanthropic） |
| `STORE_PROVIDER` | `pglite` | `pglite`（組み込み・開発用）/ `postgres`（本番） |
| `DATABASE_URL` | - | PostgreSQL接続文字列（postgres時） |
| `PGROONGA_ENABLED` | `true` | PGroonga拡張が利用可能な場合のみ全文検索を有効化 |
| `INLINE_WORKER` | pglite時true | APIプロセス内でジョブを処理（Worker分離不要のモード） |
| `AUTO_CREATE_PERSONS` | `false` | 未知の人物メンションから自動で人物を作成（既定はレビュー候補化） |
| `API_KEY` | （無効） | 設定すると `/v1` が `X-API-Key` / Bearer 認証必須に |

モックモードはありません。embeddingモデルやプロバイダを切り替えたら `npm run reembed` で既存データのベクトルを再生成してください（異なるモデルのベクトルは互換性がありません）。LLM呼び出しが失敗した場合、検索は明示的なエラーを返し、取り込みジョブはバックオフ付きでリトライされます（品質の落ちたフォールバックで黙って動き続けることはありません）。

## API

主要エンドポイント:

```http
POST /v1/sources                 # 統一ソース登録（dedup / versioning / ジョブ投入）
GET  /v1/sources/{id}/extractions
POST /v1/sources/{id}/reprocess

GET  /v1/jobs                    # ジョブ確認 / retry / cancel

POST /v1/persons                 # 人物CRUD + aliases / profile / sns / contexts / summaries / fields / relationships
PATCH /v1/persons/{id}/fields    # ユーザー定義フィールド値の設定
PATCH /v1/contexts/{id}          # 抽出結果の手動修正（編集・別人物への付け替え。再処理から保護）

POST /v1/schemas                 # スキーマ / フィールド定義（typed EAV）

POST /v1/search/persons          # ハイブリッド検索（query または Search DSL）
POST /v1/search/parse            # 自然文 → Search DSL（デバッグ用）

GET  /v1/person-candidates       # エンティティリンキング候補のレビュー（link / create-person / reject）
GET  /v1/extracted-field-candidates  # 抽出フィールド候補のレビュー（apply / reject）

GET  /v1/health  /v1/capabilities  /v1/stats  /v1/meta/searchable-fields
```

検索リクエスト例:

```bash
curl -s localhost:3000/v1/search/persons -H 'content-type: application/json' -d '{
  "query": "Instagramフォロワー100万人以上で、環境保全の文脈で最近話題になっている人物"
}'
```

レスポンスには `score`（fusion値）、`score_parts`、`matched_reasons`、`matched_contexts`（出典つき根拠）、`dsl`、`search_capabilities`、`warnings` が含まれます。

## 開発

```bash
npm run dev        # watchモード
npm run typecheck  # tsc --noEmit
npm run lint       # biome
npm test           # vitest（ユニット + インメモリPGlite統合テスト）
npm run smoke      # 起動中のAPIに対するE2Eスモーク（SMOKE_BASE_URLで対象指定）
npm run reembed    # 全embeddingを現行プロバイダで再生成（プロバイダ/モデル切替後に実行）
```

### リポジトリ構成

```text
apps/
  api/         # Fastify APIサーバー + 管理コンソール（apps/api/public）
  worker/      # スタンドアロンWorker（postgres時）
packages/
  shared/      # 設定(zod) / 型 / ユーティリティ
  db/          # pg / PGlite ドライバ抽象化・マイグレーション・capability detection
  store/       # SqlStore（CRUD / 検索実行 / ジョブキュー、両DB共通の単一実装）
  schemas/     # 型付きEAVフィールドの検証・変換
  search/      # Search DSL検証 / 自然文パーサ / スコア統合
  embeddings/  # embedding プロバイダ（OpenAI / OpenAI互換エンドポイント）
  llm/         # LLM プロバイダ（OpenAI / Anthropic）
  extraction/  # ヒューリスティック抽出 + LLM抽出タスク（zod検証つき）
  core/        # ドメインサービス + 処理パイプライン
migrations/
  core/        # 必須スキーマ（pgvector前提）
  optional/pgroonga/  # PGroonga導入時のみ適用される全文検索インデックス
```

## ライセンス

**デュアルライセンス** です。

- **コミュニティ版**: [GNU AGPL-3.0](LICENSE)
- **商用版**: AGPL-3.0 の条件に従えない利用者向けに、別途商用ライセンスを提供します。商用ライセンスの条件は個別契約により定めます。導入のお問い合わせは メール（`info@webfreak.jp`）までご連絡ください。
