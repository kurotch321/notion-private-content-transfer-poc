# notion-private-content-transfer-poc

Notionの退職予定者Privateページを、**レコード単位共有された移管先ページ配下へ移動**するGASウィザードPoCです。

## 実装内容（Issue #2）

- 管理者画面
  - 対象ユーザー識別子（メール想定）ごとに移管先レコードページIDを登録
  - 登録先は `Script Properties`（`destination:<userKey>`）
- 退職予定者ウィザード
  - PAT発行手順を表示
  - PATで移管先ページへのアクセス可否を検証
  - Notion Search APIでページ候補を取得（ページネーション対応）
  - タイトル/階層パスを表示し、対象ページを選択可能
  - dry-runで「移動対象・重複スキップ・失敗理由」を確認
  - 最終確認キーワード `MOVE` 入力後に Move Page API 相当（`PATCH /v1/pages/{id}`）で移管実行
  - 実行結果を `success / failed / skipped` で返却し、移動後parentを確認

## PoCでの検証観点対応

- 本人PATでのPrivateページ候補列挙
  - `POST /v1/search` の結果をUI表示
- Private直下判定
  - 親をたどり `parent.type === "workspace"` をトップレベルとして判定
- DB全体非共有 + レコードのみ共有の動作
  - PAT検証時に移管先レコードページ取得可否をチェック
- 個別レコード編集権限での移動
  - 実行時に移管先へMoveを実施し結果を記録
- 403/404/429対応
  - エラーメッセージを分類して返却（429はRetry-Afterを表示）

## 制約（PoC前提）

- Notion管理者OAuthは未使用（DB作成・共有設定の自動化なし）
- PATは永続保存しない（Properties/ログ/シートへの保存なし）
- 長時間処理の中断再開や秘密情報のセッション越し保持は対象外
- 子ページ/DB/添付/リンク/共有権限の最終仕様は実運用前に追加検証が必要

## ディレクトリ構成

- `src/code.ts` : GASサーバーサイド（TypeScript）
- `src/admin.html` : 管理者画面
- `src/employee.html` : 退職予定者ウィザード画面
- `src/appsscript.json` : GASマニフェスト
- `.clasp.json` : clasp設定（`scriptId` は手動設定）

## セットアップ（TypeScript + clasp）

1. 依存関係インストール

   ```bash
   npm install
   ```

2. `.clasp.json` の `scriptId` を対象GASプロジェクトに設定

3. ビルド

   ```bash
   npm run build
   ```

4. デプロイ（push）

   ```bash
   npm run deploy
   ```

5. GAS Web Appとしてデプロイし、以下URLで利用
   - 管理者画面: `...?page=admin`
   - 退職予定者画面: `...?page=employee`

## コマンド

- 型チェック: `npm run typecheck`
- ビルド: `npm run build`
- デプロイ: `npm run deploy`

## 参考

- https://developers.notion.com/guides/get-started/personal-access-tokens
- https://developers.notion.com/reference/move-page
- https://developers.notion.com/reference/post-search
