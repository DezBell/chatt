const welcome = document.querySelector('#welcome');
const conversation = document.querySelector('#conversation');
const entryError = document.querySelector('#entry-error');
const roomError = document.querySelector('#room-error');
const createForm = document.querySelector('#create-form');
const joinForm = document.querySelector('#join-form');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const imageInput = document.querySelector('#image-input');
const fileInput = document.querySelector('#file-input');
const attachMenuToggle = document.querySelector('#attach-menu-toggle');
const attachmentMenu = document.querySelector('#attachment-menu');
const attachmentPreview = document.querySelector('#attachment-preview');
const attachmentName = document.querySelector('#attachment-name');
const messagesElement = document.querySelector('#messages');
const emptyState = document.querySelector('#empty-state');
const notificationButton = document.querySelector('#notification-button');
const themeToggle = document.querySelector('#theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');

let currentRoom = null;
let lastMessageId = 0;
let hasLoadedMessages = false;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let selectedAttachment = null;
const renderedMessages = new Set();

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === 'dark';
  themeToggle.textContent = isDark ? '☼ Light mode' : '☾ Dark mode';
  themeToggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
  themeColor.content = isDark ? '#151a18' : '#f5f4f0';
  if (persist) {
    try {
      localStorage.setItem('chat-theme', theme);
    } catch {}
  }
}

themeToggle.addEventListener('click', () => {
  const currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true);
});

applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

async function api(action, { method = 'GET', body, query = {} } = {}) {
  const options = { method, headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const params = new URLSearchParams(query);
  const suffix = params.size ? `?${params}` : '';
  const response = await fetch(`/api/${action}${suffix}`, options);
  if (action === 'file') return response;

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response.');
  }
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = '';
  element.hidden = true;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    .format(new Date(Number(timestamp) * 1000));
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileUrl(messageId, view = false) {
  const params = new URLSearchParams({ code: currentRoom.code, id: String(messageId) });
  if (view) params.set('view', '1');
  return `/api/file?${params}`;
}

function addMessage(message, notify = false) {
  const id = Number(message.id);
  if (renderedMessages.has(id)) return;
  renderedMessages.add(id);
  lastMessageId = Math.max(lastMessageId, id);
  if (emptyState.isConnected) emptyState.remove();

  const row = document.createElement('article');
  row.className = `message-row${message.sender === currentRoom.nickname ? ' mine' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = `${message.sender} · ${formatTime(message.sent_at)}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message.body) {
    const text = document.createElement('div');
    text.textContent = message.body;
    bubble.append(text);
  }
  if (message.attachment) {
    if (message.attachment.type.startsWith('image/')) {
      const imageLink = document.createElement('a');
      imageLink.className = 'image-attachment';
      imageLink.href = fileUrl(id, true);
      imageLink.target = '_blank';
      imageLink.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.src = imageLink.href;
      image.alt = message.attachment.name;
      image.loading = 'lazy';
      imageLink.append(image);
      bubble.append(imageLink);
    }

    const downloadLink = document.createElement('a');
    downloadLink.className = 'attachment-link';
    downloadLink.href = fileUrl(id);
    downloadLink.textContent = `↓ ${message.attachment.name} · ${formatFileSize(message.attachment.size)}`;
    bubble.append(downloadLink);
  }

  row.append(meta, bubble);
  messagesElement.append(row);
  messagesElement.scrollTop = messagesElement.scrollHeight;

  if (notify && message.sender !== currentRoom.nickname && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`Message from ${message.sender}`, {
      body: message.body ? message.body.slice(0, 140) : `Sent ${message.attachment?.name || 'an attachment'}`,
      tag: `quiet-chat-${id}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

async function loadMessages() {
  if (!currentRoom) return;
  const room = currentRoom;
  try {
    const result = await api('messages', {
      query: { code: room.code, after: String(lastMessageId) },
    });
    if (currentRoom !== room) return;
    for (const message of result.messages) {
      addMessage(message, hasLoadedMessages);
    }
    hasLoadedMessages = true;
  } catch (error) {
    if (currentRoom === room) showError(roomError, error.message);
  }
}

function connectSocket() {
  if (!currentRoom || !('WebSocket' in window)) {
    showError(roomError, 'This browser does not support real-time chat.');
    return;
  }

  const room = currentRoom;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ code: room.code, name: room.nickname });
  const connection = new WebSocket(`${protocol}//${window.location.host}/api/stream?${params}`);
  socket = connection;

  connection.addEventListener('open', () => {
    if (socket !== connection) {
      connection.close();
      return;
    }
    reconnectDelay = 1000;
    clearError(roomError);
    loadMessages();
  });

  connection.addEventListener('message', event => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch {
      showError(roomError, 'Received an invalid chat update.');
      return;
    }
    if (update.type === 'message' && update.message) {
      addMessage(update.message, hasLoadedMessages);
      hasLoadedMessages = true;
    }
  });

  connection.addEventListener('error', () => {
    if (currentRoom === room) showError(roomError, 'Connection interrupted. Reconnecting…');
  });

  connection.addEventListener('close', () => {
    if (socket !== connection || currentRoom !== room) return;
    showError(roomError, 'Connection interrupted. Reconnecting…');
    reconnectTimer = window.setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectSocket();
    }, reconnectDelay);
  });
}

function setRoom(room, persist = true) {
  currentRoom = room;
  lastMessageId = 0;
  hasLoadedMessages = false;
  renderedMessages.clear();
  welcome.hidden = true;
  conversation.hidden = false;
  document.querySelector('#room-code').textContent = room.code;
  document.querySelector('#message-input').setAttribute('aria-label', `Write a message as ${room.nickname}`);
  clearError(roomError);

  if (persist) {
    try {
      localStorage.setItem('quiet-chat-room', JSON.stringify(room));
    } catch {}
  }

  clearTimeout(reconnectTimer);
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.close(1000, 'Changing chat rooms.');
  }
  loadMessages();
  connectSocket();
  updateNotificationButton();
  messageInput.focus();
}

async function enterRoom(action, body, submitButton) {
  clearError(entryError);
  submitButton.disabled = true;
  try {
    const result = await api(action, { method: 'POST', body });
    setRoom(result.room);
  } catch (error) {
    showError(entryError, error.message);
  } finally {
    submitButton.disabled = false;
  }
}

createForm.addEventListener('submit', event => {
  event.preventDefault();
  enterRoom('rooms', { name: new FormData(createForm).get('name') }, createForm.querySelector('button[type="submit"]'));
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  const formData = new FormData(joinForm);
  enterRoom('join', {
    name: formData.get('name'),
    code: formData.get('code').trim().toUpperCase(),
  }, joinForm.querySelector('button[type="submit"]'));
});

messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if ((!message && !selectedAttachment) || !currentRoom) return;

  const sendButton = messageForm.querySelector('button[type="submit"]');
  sendButton.disabled = true;
  clearError(roomError);
  try {
    let result;
    if (selectedAttachment) {
      const formData = new FormData();
      formData.append('code', currentRoom.code);
      formData.append('name', currentRoom.nickname);
      formData.append('message', message);
      formData.append('attachment', selectedAttachment);
      result = await api('upload', { method: 'POST', body: formData });
    } else {
      result = await api('send', {
        method: 'POST',
        body: { code: currentRoom.code, name: currentRoom.nickname, message },
      });
    }

    if (result.message) addMessage(result.message);
    messageInput.value = '';
    messageInput.style.height = '';
    clearAttachment();
  } catch (error) {
    showError(roomError, error.message);
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
  }
});

function clearAttachment() {
  imageInput.value = '';
  fileInput.value = '';
  selectedAttachment = null;
  attachmentPreview.hidden = true;
}

function handleAttachmentSelection(input) {
  const file = input.files[0];
  if (!file) return;
  (input === imageInput ? fileInput : imageInput).value = '';
  selectedAttachment = file;
  attachmentName.textContent = `${file.name} · ${formatFileSize(file.size)}`;
  attachmentPreview.hidden = false;
  clearError(roomError);
}

imageInput.addEventListener('change', () => handleAttachmentSelection(imageInput));
fileInput.addEventListener('change', () => handleAttachmentSelection(fileInput));

attachMenuToggle.addEventListener('click', () => {
  const expanded = attachMenuToggle.getAttribute('aria-expanded') === 'true';
  attachmentMenu.hidden = expanded;
  attachMenuToggle.setAttribute('aria-expanded', String(!expanded));
});

document.querySelector('#choose-photo').addEventListener('click', () => {
  attachmentMenu.hidden = true;
  attachMenuToggle.setAttribute('aria-expanded', 'false');
  imageInput.click();
});

document.querySelector('#choose-file').addEventListener('click', () => {
  attachmentMenu.hidden = true;
  attachMenuToggle.setAttribute('aria-expanded', 'false');
  fileInput.click();
});

document.querySelector('#remove-attachment').addEventListener('click', () => {
  clearAttachment();
  messageInput.focus();
});

document.addEventListener('click', event => {
  if (!event.target.closest('.attachment-picker')) {
    attachmentMenu.hidden = true;
    attachMenuToggle.setAttribute('aria-expanded', 'false');
  }
});

messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
});

messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

document.querySelector('#copy-code').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(currentRoom.code);
    button.textContent = 'Copied!';
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  } catch {
    showError(roomError, 'Could not copy the code. You can select and copy it instead.');
  }
});

function updateNotificationButton() {
  if (!('Notification' in window)) {
    notificationButton.textContent = 'Notifications unavailable';
    notificationButton.disabled = true;
  } else if (Notification.permission === 'granted') {
    notificationButton.textContent = 'Notifications on';
  } else if (Notification.permission === 'denied') {
    notificationButton.textContent = 'Notifications blocked';
    notificationButton.disabled = true;
  } else {
    notificationButton.textContent = 'Enable notifications';
    notificationButton.disabled = false;
  }
}

notificationButton.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  try {
    await Notification.requestPermission();
    updateNotificationButton();
  } catch {
    showError(roomError, 'Your browser could not enable notifications.');
  }
});

document.querySelector('#back-link').addEventListener('click', event => {
  event.preventDefault();
  clearTimeout(reconnectTimer);
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.close(1000, 'Left the chat.');
  }
  currentRoom = null;
  try {
    localStorage.removeItem('quiet-chat-room');
  } catch {}
  conversation.hidden = true;
  welcome.hidden = false;
  messagesElement.replaceChildren(emptyState);
  messageInput.value = '';
  clearAttachment();
  lastMessageId = 0;
  hasLoadedMessages = false;
  renderedMessages.clear();
});

function restoreRoom() {
  try {
    const room = JSON.parse(localStorage.getItem('quiet-chat-room') || 'null');
    if (room && /^[A-HJ-NP-Z2-9]{12}$/.test(room.code) && validStoredName(room.nickname)) {
      setRoom(room, false);
    }
  } catch {}
}

function validStoredName(name) {
  return typeof name === 'string' && name.trim().length > 0 && Array.from(name).length <= 30;
}

restoreRoom();
updateNotificationButton();
