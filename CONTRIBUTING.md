# コントリビューションガイド

## ライセンスと権利の集約

本プロジェクトはデュアルライセンス（AGPL-3.0 + 商用ライセンス）です。
商用ライセンスを提供し続けるには、メンテナがすべてのコードを **AGPL-3.0 と商用ライセンスの双方で再許諾できる**状態を保つ必要があります。

そのため、プルリクエスト等でコントリビューションを提出した時点で、提出者は以下に同意したものとみなします（CLA: Contributor License Agreement 相当）:

- 提出したコントリビューションを、メンテナが **AGPL-3.0 および商用ライセンスの両方**で利用・再許諾することを許諾する
- 提出者が当該コントリビューションを上記条件で提供する権利を有している（第三者の権利を侵害しない、所属組織の許諾を得ている）

## 開発の進め方

```bash
npm install
cp .env.example .env        # OPENAI_API_KEY / LLM_MODEL / EMBEDDING_MODEL を設定
npm run dev                 # PGliteで起動（http://localhost:3000）
npm run check               # typecheck + lint + test（提出前に必須）
```

- `npm run check` を通してから提出してください
