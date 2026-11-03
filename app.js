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

let csrfToken = '';
let currentRoom = null;
let lastMessageId = 0;
let hasLoadedMessages = false;
let pollTimer = null;
let selectedAttachment = null;

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

async function request(action, { method = 'GET', body, query = {} } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['X-CSRF-Token'] = csrfToken;
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }

  const params = new URLSearchParams({ action, ...query });
  const response = await fetch(`api.php?${params}`, options);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response.');
  }
  if (!response.ok) {
    throw new Error(result.error || 'Something went wrong. Please try again.');
  }
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

function addMessage(message, notify = false) {
  if (emptyState) emptyState.remove();

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
    const attachmentUrl = new URLSearchParams({ action: 'file', id: String(message.id) });
    const downloadLink = document.createElement('a');
    downloadLink.className = 'attachment-link';
    downloadLink.href = `api.php?${attachmentUrl}`;
    downloadLink.textContent = `↓ ${message.attachment.name} · ${formatFileSize(message.attachment.size)}`;

    if (message.attachment.type.startsWith('image/')) {
      const imageUrl = new URLSearchParams({ action: 'file', id: String(message.id), view: '1' });
      const imageLink = document.createElement('a');
      imageLink.className = 'image-attachment';
      imageLink.href = `api.php?${imageUrl}`;
      imageLink.target = '_blank';
      imageLink.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.src = imageLink.href;
      image.alt = message.attachment.name;
      image.loading = 'lazy';
      imageLink.append(image);
      bubble.append(imageLink);
    }

    bubble.append(downloadLink);
  }

  row.append(meta, bubble);
  messagesElement.append(row);
  messagesElement.scrollTop = messagesElement.scrollHeight;

  if (notify && message.sender !== currentRoom.nickname && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`Message from ${message.sender}`, {
      body: message.body ? message.body.slice(0, 140) : `Sent ${message.attachment?.name || 'an attachment'}`,
      tag: `quiet-chat-${message.id}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function setRoom(room) {
  currentRoom = room;
  lastMessageId = 0;
  hasLoadedMessages = false;
  welcome.hidden = true;
  conversation.hidden = false;
  document.querySelector('#room-code').textContent = room.code;
  document.querySelector('#room-title').textContent = 'Chat';
  document.querySelector('#message-input').setAttribute('aria-label', `Write a message as ${room.nickname}`);
  clearError(roomError);
  updateNotificationButton();
  pollMessages();
  clearInterval(pollTimer);
  pollTimer = setInterval(pollMessages, 2500);
  messageInput.focus();
}

async function pollMessages() {
  if (!currentRoom) return;
  try {
    const result = await request('messages', { query: { after: String(lastMessageId) } });
    for (const message of result.messages) {
      const shouldNotify = hasLoadedMessages;
      addMessage(message, shouldNotify);
      lastMessageId = Math.max(lastMessageId, Number(message.id));
    }
    hasLoadedMessages = true;
  } catch (error) {
    showError(roomError, error.message);
    clearInterval(pollTimer);
  }
}

async function enterRoom(action, body, submitButton) {
  clearError(entryError);
  submitButton.disabled = true;
  try {
    const result = await request(action, { method: 'POST', body });
    setRoom(result.room);
  } catch (error) {
    showError(entryError, error.message);
  } finally {
    submitButton.disabled = false;
  }
}

createForm.addEventListener('submit', event => {
  event.preventDefault();
  const submitButton = createForm.querySelector('button[type="submit"]');
  enterRoom('create_room', { name: new FormData(createForm).get('name') }, submitButton);
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  const formData = new FormData(joinForm);
  const submitButton = joinForm.querySelector('button[type="submit"]');
  enterRoom('join_room', {
    name: formData.get('name'),
    code: formData.get('code').trim().toUpperCase(),
  }, submitButton);
});

messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = messageInput.value.trim();
  const file = selectedAttachment;
  if ((!message && !file) || !currentRoom) return;

  const sendButton = messageForm.querySelector('button[type="submit"]');
  sendButton.disabled = true;
  clearError(roomError);
  try {
    if (file) {
      const formData = new FormData();
      formData.append('attachment', file);
      if (message) formData.append('message', message);
      await request('upload', { method: 'POST', body: formData });
    } else {
      await request('send', { method: 'POST', body: { message } });
    }
    messageInput.value = '';
    messageInput.style.height = '';
    imageInput.value = '';
    fileInput.value = '';
    selectedAttachment = null;
    attachmentPreview.hidden = true;
    await pollMessages();
  } catch (error) {
    showError(roomError, error.message);
  } finally {
    sendButton.disabled = false;
    messageInput.focus();
  }
});

function handleAttachmentSelection(input) {
  const file = input.files[0];
  if (!file) {
    return;
  }

  const otherInput = input === imageInput ? fileInput : imageInput;
  otherInput.value = '';
  selectedAttachment = file;
  attachmentName.textContent = `${file.name} · ${formatFileSize(file.size)}`;
  attachmentPreview.hidden = false;
  clearError(roomError);
}

imageInput.addEventListener('change', () => handleAttachmentSelection(imageInput));
fileInput.addEventListener('change', () => handleAttachmentSelection(fileInput));

attachMenuToggle.addEventListener('click', () => {
  const isExpanded = attachMenuToggle.getAttribute('aria-expanded') === 'true';
  attachmentMenu.hidden = isExpanded;
  attachMenuToggle.setAttribute('aria-expanded', String(!isExpanded));
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
  imageInput.value = '';
  fileInput.value = '';
  selectedAttachment = null;
  attachmentPreview.hidden = true;
  messageInput.focus();
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

document.querySelector('#back-link').addEventListener('click', async event => {
  event.preventDefault();
  try {
    await request('leave', { method: 'POST', body: {} });
    clearInterval(pollTimer);
    currentRoom = null;
    conversation.hidden = true;
    welcome.hidden = false;
    messagesElement.replaceChildren(emptyState);
    messageInput.value = '';
    imageInput.value = '';
    fileInput.value = '';
    selectedAttachment = null;
    attachmentPreview.hidden = true;
    lastMessageId = 0;
    hasLoadedMessages = false;
  } catch (error) {
    showError(roomError, error.message);
  }
});

async function start() {
  try {
    const result = await request('bootstrap');
    csrfToken = result.csrf;
    updateNotificationButton();
    if (result.room) setRoom(result.room);
  } catch (error) {
    showError(entryError, error.message);
  }
}

start();
