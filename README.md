# Karotter用語積み

カロッターの用語を文字の形のまま土台へ積む、スカイブルー基調のブラウザーゲーム試作品です。ひとり用と、ルームIDで遊ぶマルチプレイを収録しています。

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

## マルチプレイ

- ルーム作成者がゲームリーダーです。2人以上集まるまで開始できず、開始操作はリーダーだけが行えます。
- 最大10人。開始後に入室した人は自動的に観戦になります。
- 各ターンは10秒で、時間切れになると自動で用語が落ちます。
- 用語が土台から落ちた人は、観戦するか退出するかを選べます。
- 勝負の結果を短く表示したあと、同じルームの開始待ちへ戻ります。
- プレイ中・観戦中のメンバーを分けて表示し、チャットはロビー・プレイ中・観戦中のどの状態でも利用できます。
- OAuth のプロフィール画像はチャットのアイコンと名前に使います。

## Render と OAuth

`render.yaml` は無料の Node Web Service 用です。Node.js 22 と Singapore リージョンを指定しています。GitHub リポジトリを Render Blueprint に接続し、次の環境変数を設定してください。

- `PUBLIC_ORIGIN`: Render の公開 URL
- `KAROTTER_CLIENT_ID`: Karotter OAuth アプリの Client ID
- `KAROTTER_CLIENT_SECRET`: confidential client の場合のみ
- `SUPABASE_SERVICE_ROLE_KEY`: 既存 Supabase プロジェクトの service role key

`KAROTTER_CLIENT_SECRET` は Karotter 側で confidential client として発行した場合に設定します。Karotter の[設定ページ](https://karotter.com/settings)で OAuth アプリを作成し、コールバック URL に `https://<サービス名>.onrender.com/auth/callback` を登録してください。`PUBLIC_ORIGIN` には `https://<サービス名>.onrender.com` を設定します。認可に使うスコープは `profile` です。

ルームの保存先は既存 Supabase プロジェクトの `public.karotter_stack_rooms` だけです。このテーブルは作成済みで、構造は [db/karotter_stack_rooms.sql](db/karotter_stack_rooms.sql) に記録しています。匿名ユーザーには直接アクセス権を付けず、サーバーが service role で読み書きします。鍵は GitHub にコミットしないでください。

Render の無料サービスは待機中にスリープし、再起動時には進行中だった対戦を開始待ちへ戻します。ルームとチャットは Supabase に保存されます。

## 確認

```sh
npm run build
node --test tests/multiplayer.test.mjs
node --test tests/recovery.test.mjs
```

用語の表記は[カロッター用語辞典](https://karotter-wiki.vercel.app/index/index.html)を参考にしています。
