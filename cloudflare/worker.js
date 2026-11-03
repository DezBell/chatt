const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;

function jsonResponse(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function validName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && Array.from(name).length <= 30 ? name : null;
}

function validRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value.toUpperCase())
    ? value.toUpperCase()
    : null;
}

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, byte => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function roomStub(env, code) {
  return env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(code));
}

async function roomJson(env, code, path, body) {
  const response = await roomStub(env, code).fetch(`https://room.internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    return { response, result };
  }
  return { response, result };
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

function contentMatches(extension, bytes) {
  const startsWith = (...values) => values.every((value, index) => bytes[index] === value);
  const ascii = (offset, text) => {
    if (bytes.length < offset + text.length) return false;
    return text.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  };

  if (['jpg', 'jpeg'].includes(extension)) return startsWith(0xff, 0xd8, 0xff);
  if (extension === 'png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (extension === 'gif') return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
  if (extension === 'webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (extension === 'pdf') return ascii(0, '%PDF-');
  if (['docx', 'xlsx'].includes(extension)) return startsWith(0x50, 0x4b, 0x03, 0x04);
  if (['txt', 'csv'].includes(extension)) return true;
  return false;
}

function attachmentType(extension) {
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extension] || null;
}

async function handleApi(request, env, url) {
  const method = request.method;
  const route = url.pathname.slice('/api/'.length);

  if (route === 'rooms' && method === 'POST') {
    if (!sameOrigin(request, url)) return errorResponse('Cross-origin requests are not allowed.', 403);
    let data;
    try {
      data = await request.json();
    } catch {
      return errorResponse('Please send a valid request.', 400);
    }

    const name = validName(data.name);
    if (!name) return errorResponse('Your name must be between 1 and 30 characters.', 422);

    const code = newRoomCode();
    const { response, result } = await roomJson(env, code, '/internal/init', { code });
    if (!response.ok) throw new Error(result.error || 'Could not create the chat room.');
    return jsonResponse({ room: { code, nickname: name } }, 201);
  }

  if (route === 'join' && method === 'POST') {
    if (!sameOrigin(request, url)) return errorResponse('Cross-origin requests are not allowed.', 403);
    let data;
    try {
      data = await request.json();
    } catch {
      return errorResponse('Please send a valid request.', 400);
    }

    const name = validName(data.name);
    if (!name) return errorResponse('Your name must be between 1 and 30 characters.', 422);
    const code = validRoomCode(data.code);
    if (!code) return errorResponse('Enter a valid 12-character room code.', 422);

    const { response, result } = await roomJson(env, code, '/internal/exists');
    if (!response.ok) throw new Error(result.error || 'Could not check the chat room.');
    if (!result.exists) return errorResponse('We couldn’t find that room. Check the code and try again.', 404);
    return jsonResponse({ room: { code, nickname: name } });
  }

  if (route === 'messages' && method === 'GET') {
    const code = validRoomCode(url.searchParams.get('code'));
    const after = Number(url.searchParams.get('after') || '0');
    if (!code) return errorResponse('Join a room before viewing messages.', 401);
    if (!Number.isSafeInteger(after) || after < 0) return errorResponse('Invalid message cursor.', 400);

    const { response, result } = await roomJson(env, code, `/internal/messages?after=${after}`);
    if (!response.ok) return errorResponse(result.error || 'Could not load messages.', response.status);
    return jsonResponse(result);
  }

  if (route === 'send' && method === 'POST') {
    if (!sameOrigin(request, url)) return errorResponse('Cross-origin requests are not allowed.', 403);
    let data;
    try {
      data = await request.json();
    } catch {
      return errorResponse('Please send a valid request.', 400);
    }

    const code = validRoomCode(data.code);
    const name = validName(data.name);
    if (!code) return errorResponse('Join a room before sending messages.', 401);
    if (!name) return errorResponse('Your name must be between 1 and 30 characters.', 422);
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (!message || Array.from(message).length > MAX_MESSAGE_LENGTH) {
      return errorResponse('Messages must be between 1 and 2,000 characters.', 422);
    }

    const { response, result } = await roomJson(env, code, '/internal/send', { name, message });
    if (!response.ok) return errorResponse(result.error || 'Could not send the message.', response.status);
    return jsonResponse(result);
  }

  if (route === 'upload' && method === 'POST') {
    if (!sameOrigin(request, url)) return errorResponse('Cross-origin requests are not allowed.', 403);
    const length = Number(request.headers.get('Content-Length') || '0');
    if (length > MAX_FILE_SIZE + 64 * 1024) return errorResponse('Files must be 10 MB or smaller.', 413);

    let form;
    try {
      form = await request.formData();
    } catch {
      return errorResponse('The upload could not be read. Try again.', 400);
    }

    const code = validRoomCode(form.get('code'));
    const name = validName(form.get('name'));
    const file = form.get('attachment');
    if (!code) return errorResponse('Join a room before sending attachments.', 401);
    if (!name) return errorResponse('Your name must be between 1 and 30 characters.', 422);
    if (!(file instanceof File) || file.size < 1) return errorResponse('Choose an image or file to attach.', 422);
    if (file.size > MAX_FILE_SIZE) return errorResponse('Files must be 10 MB or smaller.', 413);

    const caption = typeof form.get('message') === 'string' ? form.get('message').trim() : '';
    if (Array.from(caption).length > MAX_MESSAGE_LENGTH) {
      return errorResponse('Messages must be 2,000 characters or fewer.', 422);
    }

    const originalName = file.name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const extension = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : '';
    const type = attachmentType(extension);
    if (originalName.length > 255) return errorResponse('File names must be 255 characters or fewer.', 422);
    if (!type) {
      return errorResponse('Use JPG, PNG, GIF, WEBP, PDF, TXT, CSV, DOCX, or XLSX files.', 415);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!contentMatches(extension, bytes)) return errorResponse('The file contents do not match its file type.', 415);

    const { response: roomResponse, result: roomResult } = await roomJson(env, code, '/internal/exists');
    if (!roomResponse.ok) throw new Error(roomResult.error || 'Could not check the chat room.');
    if (!roomResult.exists) return errorResponse('We couldn’t find that room. Check the code and try again.', 404);

    const storageKey = `${code}/${crypto.randomUUID()}`;
    await env.CHAT_FILES.put(storageKey, bytes, {
      httpMetadata: { contentType: type },
    });

    try {
      const { response, result } = await roomJson(env, code, '/internal/attachment', {
        name,
        caption,
        attachment: {
          key: storageKey,
          name: originalName,
          type,
          size: file.size,
        },
      });
      if (!response.ok) throw new Error(result.error || 'Could not save attachment details.');
      return jsonResponse(result);
    } catch (error) {
      await env.CHAT_FILES.delete(storageKey);
      throw error;
    }
  }

  if (route === 'file' && method === 'GET') {
    const code = validRoomCode(url.searchParams.get('code'));
    const id = Number(url.searchParams.get('id'));
    if (!code) return errorResponse('Join a room to view its attachments.', 401);
    if (!Number.isSafeInteger(id) || id < 1) return errorResponse('Attachment not found.', 404);

    const { response, result } = await roomJson(env, code, `/internal/attachment?id=${id}`);
    if (!response.ok) return errorResponse(result.error || 'Attachment not found.', response.status);
    const object = await env.CHAT_FILES.get(result.attachment.key);
    if (!object) return errorResponse('This attachment is no longer available.', 404);

    const inline = url.searchParams.get('view') === '1' && result.attachment.type.startsWith('image/');
    const safeName = result.attachment.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
    const disposition = inline ? 'inline' : 'attachment';
    return new Response(object.body, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(result.attachment.name)}`,
        'Content-Length': String(object.size),
        'Content-Type': result.attachment.type,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (route === 'stream' && method === 'GET') {
    if (!sameOrigin(request, url)) return errorResponse('Cross-origin requests are not allowed.', 403);
    const code = validRoomCode(url.searchParams.get('code'));
    const name = validName(url.searchParams.get('name'));
    if (!code || !name) return errorResponse('Join a room before opening chat.', 401);
    const { response, result } = await roomJson(env, code, '/internal/exists');
    if (!response.ok) throw new Error(result.error || 'Could not check the chat room.');
    if (!result.exists) return errorResponse('We couldn’t find that room.', 404);

    const stub = roomStub(env, code);
    const roomUrl = new URL('https://room.internal/internal/stream');
    roomUrl.searchParams.set('name', name);
    return stub.fetch(new Request(roomUrl, request));
  }

  return errorResponse('That action is not available.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error('Quiet Chat Worker request failed:', error);
        return errorResponse('The chat service is temporarily unavailable. Please try again.', 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

export class ChatRoom {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL)'
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        attachment_key TEXT,
        attachment_name TEXT,
        attachment_type TEXT,
        attachment_size INTEGER,
        created_at INTEGER NOT NULL
      )`
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/internal/stream') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return errorResponse('A WebSocket connection is required.', 426);
      }
      const name = validName(url.searchParams.get('name'));
      if (!name || !this.exists()) return errorResponse('Join a room before opening chat.', 401);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [name]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === '/internal/init' && request.method === 'POST') {
      const data = await request.json();
      this.sql.exec('INSERT OR IGNORE INTO room (id, code) VALUES (1, ?)', data.code);
      return jsonResponse({ ok: true });
    }

    if (path === '/internal/exists' && request.method === 'GET') {
      return jsonResponse({ exists: this.exists() });
    }

    if (path === '/internal/messages' && request.method === 'GET') {
      if (!this.exists()) return errorResponse('Room not found.', 404);
      const after = Number(url.searchParams.get('after') || '0');
      if (!Number.isSafeInteger(after) || after < 0) return errorResponse('Invalid message cursor.', 400);
      const messages = this.sql.exec(
        'SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT 100',
        after
      ).toArray().map(row => this.messageShape(row));
      return jsonResponse({ messages });
    }

    if (path === '/internal/send' && request.method === 'POST') {
      const data = await request.json();
      const name = validName(data.name);
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      if (!this.exists()) return errorResponse('Room not found.', 404);
      if (!name) return errorResponse('Your name must be between 1 and 30 characters.', 422);
      if (!message || Array.from(message).length > MAX_MESSAGE_LENGTH) {
        return errorResponse('Messages must be between 1 and 2,000 characters.', 422);
      }
      const saved = this.saveMessage(name, message, null);
      this.broadcast(saved);
      return jsonResponse({ ok: true, message: saved });
    }

    if (path === '/internal/attachment' && request.method === 'POST') {
      const data = await request.json();
      const name = validName(data.name);
      const attachment = data.attachment;
      const caption = typeof data.caption === 'string' ? data.caption.trim() : '';
      if (!this.exists()) return errorResponse('Room not found.', 404);
      if (!name || !attachment || typeof attachment.key !== 'string') {
        return errorResponse('Invalid attachment details.', 422);
      }
      if (Array.from(caption).length > MAX_MESSAGE_LENGTH) {
        return errorResponse('Messages must be 2,000 characters or fewer.', 422);
      }
      const saved = this.saveMessage(name, caption, attachment);
      this.broadcast(saved);
      return jsonResponse({ ok: true, message: saved });
    }

    if (path === '/internal/attachment' && request.method === 'GET') {
      if (!this.exists()) return errorResponse('Room not found.', 404);
      const id = Number(url.searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id < 1) return errorResponse('Attachment not found.', 404);
      const row = this.sql.exec(
        'SELECT * FROM messages WHERE id = ? AND attachment_key IS NOT NULL',
        id
      ).toArray()[0];
      if (!row) return errorResponse('Attachment not found.', 404);
      return jsonResponse({
        attachment: {
          key: row.attachment_key,
          name: row.attachment_name,
          type: row.attachment_type,
          size: row.attachment_size,
        },
      });
    }

    return errorResponse('That action is not available.', 404);
  }

  exists() {
    return this.sql.exec('SELECT id FROM room WHERE id = 1').toArray().length > 0;
  }

  saveMessage(sender, body, attachment) {
    const createdAt = Math.floor(Date.now() / 1000);
    this.sql.exec(
      `INSERT INTO messages
       (sender, body, attachment_key, attachment_name, attachment_type, attachment_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sender,
      body,
      attachment?.key ?? null,
      attachment?.name ?? null,
      attachment?.type ?? null,
      attachment?.size ?? null,
      createdAt
    );
    const id = this.sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
    const row = this.sql.exec('SELECT * FROM messages WHERE id = ?', id).toArray()[0];
    return this.messageShape(row);
  }

  messageShape(row) {
    const message = {
      id: Number(row.id),
      sender: row.sender,
      body: row.body,
      sent_at: Number(row.created_at),
      attachment: null,
    };
    if (row.attachment_key) {
      message.attachment = {
        name: row.attachment_name,
        type: row.attachment_type,
        size: Number(row.attachment_size),
      };
    }
    return message;
  }

  broadcast(message) {
    const payload = JSON.stringify({ type: 'message', message });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error('Could not deliver a chat update to one connected client:', error);
        socket.close(1011, 'Unable to deliver chat update.');
      }
    }
  }

  webSocketMessage(socket, message) {
    if (message === 'ping') socket.send('pong');
  }

  webSocketClose() {}

  webSocketError(socket, error) {
    console.error('Quiet Chat WebSocket error:', error);
    socket.close(1011, 'Chat connection error.');
  }
}
