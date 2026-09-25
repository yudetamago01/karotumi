# Karotter用語積み

カロッターの用語を文字の形のまま土台へ積む、スカイブルー基調のブラウザーゲーム試作品です。ひとり用、個数ランキング、ルームIDで遊ぶマルチプレイを収録しています。

## ローカル起動

```sh
npm install
npm run dev
```

マルチプレイをローカルで確認するときは、別のターミナルでもサーバーを起動します。

```sh
npm run dev:server
```

`http://127.0.0.1:5173/` を開いてください。開発サーバーでは Karotter OAuth の代わりに名前だけのローカルテストログインを使えます。

用語は画面下の回転ボタン、または Q・E キーで15度ずつ回転できます。回転ボタンは押し続けると連続で回ります。マウスではクリック、スマホでは指を離すと落下します。

ゲーム内の 👈・💪・🥕 は、Microsoft の [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) の3D画像を同梱しています。すべての端末で同じ画像と当たり判定を使います。画像のライセンスは [src/assets/emoji/LICENSE.txt](src/assets/emoji/LICENSE.txt) を参照してください。

## マルチプレイ

- ルーム作成者がゲームリーダーです。2人以上集まるまで開始できず、開始操作はリーダーだけが行えます。
- 最大10人。開始後に入室した人は自動的に観戦になります。
- 各ターンは10秒で、時間切れになると自動で用語が落ちます。
- 用語が土台から落ちた人は、観戦するか退出するかを選べます。
- 勝負の結果を短く表示したあと、同じルームの開始待ちへ戻ります。
- プレイ中・観戦中のメンバーを分けて表示し、チャットはロビー・プレイ中・観戦中のどの状態でも利用できます。
- OAuth のプロフィール画像はチャットのアイコンと名前に使います。

## 個数ランキング

ホームの「ランキング」から、ひとりで積んだ最高個数の上位20件を見られます。Karotter にログインしてゲームを始めると、サーバーが用語の順番を発行します。ゲームオーバー時は操作記録を自動送信し、サーバーが文字の当たり判定と物理演算を再現して個数を確定します。ブラウザーから個数だけを送っても記録できません。各ユーザーの最高記録を1件だけ保持し、低い記録では上書きしません。ローカル開発時のテストログイン記録はメモリ上だけに保存します。サーバーの再起動中に進行中だった一人用の記録は失効します。

## Render と OAuth

`render.yaml` は無料の Node Web Service 用です。Node.js 22 と Singapore リージョンを指定しています。GitHub リポジトリを Render Blueprint に接続し、次の環境変数を設定してください。

Render の Web Service 作成画面から手動で設定する場合は、Root Directory を空欄、Build Command を `npm ci --include=dev && npm run build`、Start Command を `npm run start` にしてください。`NODE_ENV=production` でもビルド用の Vite をインストールするために `--include=dev` が必要です。

- `PUBLIC_ORIGIN`: Render の公開 URL
- `SESSION_SECRET`: ログイン状態を保持するための固定したランダムな文字列（Blueprint では自動生成）
- `KAROTTER_CLIENT_ID`: Karotter OAuth アプリの Client ID
- `KAROTTER_CLIENT_SECRET`: confidential client の場合のみ
- `SUPABASE_URL`: 既存 Supabase プロジェクトの URL（Blueprint には設定済み）
- `SUPABASE_SERVICE_ROLE_KEY`: 既存 Supabase プロジェクトの service role key

`KAROTTER_CLIENT_SECRET` は Karotter 側で confidential client として発行した場合に設定します。Karotter の[設定ページ](https://karotter.com/settings)で OAuth アプリを作成し、コールバック URL に `https://<サービス名>.onrender.com/auth/callback` を登録してください。`PUBLIC_ORIGIN` には `https://<サービス名>.onrender.com` を設定します。認可に使うスコープは `profile` です。

ブラウザーの認証は `https://api.karotter.com/login` から始め、ログイン後に同じホストの `/api/oauth/authorize` へ進みます。`karotter.com/login` から戻ると認可先が `karotter.com` 側になり、ログイン画面へ戻る場合があります。

ルームとランキングは既存 Supabase プロジェクト内の専用テーブル `public.karotter_stack_rooms` と `public.karotter_stack_solo_scores` に保存します。両テーブルは作成済みで、構造は [db/karotter_stack_rooms.sql](db/karotter_stack_rooms.sql) と [db/karotter_stack_solo_scores.sql](db/karotter_stack_solo_scores.sql) に記録しています。匿名ユーザーには直接アクセス権を付けず、サーバーが service role で読み書きします。鍵は GitHub にコミットしないでください。

Render の無料サービスは待機中にスリープし、再起動時には進行中だった対戦を開始待ちへ戻します。ルームとチャットは Supabase に保存されます。

### 通信量

容量とは別に、Render の外向き通信量と Supabase の egress が制限されます。[Render Hobby は月5 GB](https://render.com/docs/outbound-bandwidth)で、ブラウザーへの配信に加え、Render から Supabase へのリクエストも対象です。[Supabase Free は uncached 月5 GB、cached 月5 GB](https://supabase.com/docs/guides/platform/manage-your-usage/egress)で、DBの読み取りは uncached 側です。Supabase の枠は既存の Yude Strike と共有します。

マルチプレイでは、動いている文字の位置だけを約6回/秒で送ります。チャットは新しい1件だけを配信し、ルームのDB保存は状態が変わったときに数秒分をまとめて行います。ランキング一覧は上位20件に絞り、サーバー内で60秒キャッシュします。JS/CSSは圧縮して配信します。これでも利用人数・プレイ時間によっては無料枠を超えるため、公開後は Render の Metrics / Billing と Supabase 組織の Usage で実測してください。

## 確認

```sh
npm run build
node --test tests/multiplayer.test.mjs
node --test tests/recovery.test.mjs
node --test tests/ranking.test.mjs
```

用語の表記は[カロッター用語辞典](https://karotter-wiki.vercel.app/index/index.html)を参考にしています。
