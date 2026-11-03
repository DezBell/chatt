# Quiet Chat

A small private chat app for XAMPP. Create a room, share its 8-character code, and the other person can join with a name. Messages are stored in MySQL and appear on the other person's page within a few seconds.

## Cloudflare Workers deployment

The Cloudflare edition is in `cloudflare/` and is separate from the XAMPP/PHP app. It uses Workers to serve the site and API, a SQLite-backed Durable Object per room for real-time messages, and a private R2 bucket for attachments. It does not use PHP or the XAMPP MySQL database.

1. In the Cloudflare dashboard, create an R2 bucket named `quiet-chat-uploads`, or change `bucket_name` in `wrangler.toml` to match a bucket you create.
2. In **Workers & Pages**, create a Worker from your GitHub repository. Set the project root to the repository root, the build command to `npm run build`, and the deploy command to `npm run deploy`. The deployment runs Wrangler and applies the Durable Object migration in `wrangler.toml`.
3. Keep the Worker and R2 binding names in `wrangler.toml` (`CHAT_ROOMS` and `CHAT_FILES`) unchanged, or update the code to match any binding names you change.
4. Open the deployed `workers.dev` URL, create a room, and test joining it in another browser. Use HTTPS for browser notifications.

You can also deploy from a local terminal after installing Node.js: run `npm install`, create the R2 bucket with `npx wrangler r2 bucket create quiet-chat-uploads`, authenticate with `npx wrangler login`, then run `npm run deploy`.

The Cloudflare app uses WebSockets instead of frequent message polling. A room code is a private invitation: anyone who has it can read and post in that room, so only share it with the intended person. Existing rooms and files in the local XAMPP MySQL database are not migrated automatically; create new rooms on the Cloudflare version.

Cloudflare's published free allocations include 100,000 Workers requests per day, Durable Object free usage with daily quotas, and 10 GB-month of standard R2 storage plus free egress. Quotas can change; check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before deployment. Cloudflare Workers free hosting is not a guarantee of unlimited or permanent free usage.

## Run it with XAMPP

1. Copy this folder into `C:\xampp\htdocs\chat` if it is not already there.
2. Open the XAMPP Control Panel and start **Apache** and **MySQL**.
3. Open `http://localhost/phpmyadmin`, choose **Import**, select `database.sql`, and click **Import**.
   If you already have a Quiet Chat database, import `attachments.sql` instead to add attachment support without changing existing rooms or messages.
4. Visit `http://localhost/chat` in your browser.
5. Create a room and send the room code to the person you want to talk to. They open the same address, choose a name, and join with that code.

The default database connection is XAMPP's `root` account with no password. To use different credentials, set `CHAT_DB_HOST`, `CHAT_DB_NAME`, `CHAT_DB_USER`, and `CHAT_DB_PASSWORD` in the PHP environment.

## Notifications and access

Choose **Enable notifications** in the room and allow notifications in the browser. Incoming messages can then show desktop notifications while the chat page is open, including when its tab is in the background. Browser notifications require a secure context: `localhost` is supported; access from another device generally requires HTTPS.

This version checks for new messages every 2.5 seconds while the page is open. It does not send push notifications after the browser is closed. For another person to connect, the XAMPP server must be reachable from their device; `localhost` only works on the computer running XAMPP. Do not expose a default XAMPP installation directly to the public internet.

The room code acts as the invitation: anyone who has it can join and read that room. Share it only with the intended person.

## Images and attachments

Use the **+** button beside the message box to choose **Photo or image** or **Document or file**. Attach one file per message. Supported types are JPG, PNG, GIF, WEBP, PDF, TXT, CSV, DOCX, and XLSX, up to 10 MB per file. You can add a caption before sending. Images display automatically in the conversation; other attachments can be downloaded by room members.

Uploads are stored outside the web document root in `C:\xampp\chat_uploads` by default, and are served through the app only to members of that room. To choose another storage directory, set `CHAT_UPLOAD_DIR` for Apache's PHP environment and ensure Apache can write to it. PHP's `upload_max_filesize` must be at least `10M` and `post_max_size` greater than `10M` in `C:\xampp\php\php.ini`; restart Apache after changing these values.
