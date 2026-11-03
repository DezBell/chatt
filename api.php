<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

start_app_session();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function input_data(): array
{
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) {
        respond(['error' => 'Please send a valid request.'], 400);
    }
    return $data;
}

function require_csrf(array $data): void
{
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($provided) || !hash_equals($_SESSION['csrf'] ?? '', $provided)) {
        respond(['error' => 'Your session expired. Refresh the page and try again.'], 403);
    }
}

function require_csrf_header(): void
{
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($provided) || !hash_equals($_SESSION['csrf'] ?? '', $provided)) {
        respond(['error' => 'Your session expired. Refresh the page and try again.'], 403);
    }
}

function require_room(): int
{
    if (empty($_SESSION['room_id']) || empty($_SESSION['nickname'])) {
        respond(['error' => 'Join a room before sending messages.'], 401);
    }
    return (int) $_SESSION['room_id'];
}

function valid_nickname(mixed $value): string
{
    $name = trim(is_string($value) ? $value : '');
    if ($name === '' || mb_strlen($name) > 30) {
        respond(['error' => 'Your name must be between 1 and 30 characters.'], 422);
    }
    return $name;
}

try {
    $action = $_GET['action'] ?? '';

    if ($action === 'bootstrap' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        respond([
            'csrf' => $_SESSION['csrf'],
            'room' => isset($_SESSION['room_id'], $_SESSION['nickname'], $_SESSION['room_code'])
                ? [
                    'code' => $_SESSION['room_code'],
                    'nickname' => $_SESSION['nickname'],
                ]
                : null,
        ]);
    }

    if ($action === 'messages' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $roomId = require_room();
        $after = filter_var($_GET['after'] ?? '0', FILTER_VALIDATE_INT);
        if ($after === false || $after < 0) {
            respond(['error' => 'Invalid message cursor.'], 400);
        }

        $statement = db()->prepare(
            'SELECT m.id, m.sender, m.body, UNIX_TIMESTAMP(m.created_at) AS sent_at,
                    a.original_name AS attachment_name, a.mime_type AS attachment_type,
                    a.file_size AS attachment_size
             FROM messages m
             LEFT JOIN attachments a ON a.message_id = m.id
             WHERE m.room_id = ? AND m.id > ?
             ORDER BY m.id ASC
             LIMIT 100'
        );
        $statement->execute([$roomId, $after]);
        $messages = $statement->fetchAll();
        foreach ($messages as &$message) {
            if ($message['attachment_name'] !== null) {
                $message['attachment'] = [
                    'name' => $message['attachment_name'],
                    'type' => $message['attachment_type'],
                    'size' => (int) $message['attachment_size'],
                ];
            } else {
                $message['attachment'] = null;
            }
            unset($message['attachment_name'], $message['attachment_type'], $message['attachment_size']);
        }
        unset($message);
        respond(['messages' => $messages]);
    }

    if ($action === 'file' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $roomId = require_room();
        $fileId = filter_var($_GET['id'] ?? null, FILTER_VALIDATE_INT);
        if ($fileId === false || $fileId < 1) {
            respond(['error' => 'Attachment not found.'], 404);
        }

        $statement = db()->prepare(
            'SELECT a.storage_key, a.original_name, a.mime_type, a.file_size
             FROM attachments a
             JOIN messages m ON m.id = a.message_id
             WHERE a.message_id = ? AND m.room_id = ?'
        );
        $statement->execute([$fileId, $roomId]);
        $attachment = $statement->fetch();
        if (!$attachment) {
            respond(['error' => 'Attachment not found.'], 404);
        }

        $path = upload_directory() . DIRECTORY_SEPARATOR . $attachment['storage_key'];
        if (!is_file($path) || !is_readable($path)) {
            respond(['error' => 'This attachment is no longer available.'], 404);
        }

        $inline = isset($_GET['view'])
            && $_GET['view'] === '1'
            && str_starts_with($attachment['mime_type'], 'image/');
        $disposition = $inline ? 'inline' : 'attachment';
        $safeName = preg_replace('/[^A-Za-z0-9._-]/', '_', $attachment['original_name']) ?: 'attachment';
        header_remove('Content-Type');
        header('Content-Type: ' . $attachment['mime_type']);
        header('Content-Length: ' . (string) $attachment['file_size']);
        header('Content-Disposition: ' . $disposition . '; filename="' . $safeName . '"; filename*=UTF-8\'\'' . rawurlencode($attachment['original_name']));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store');
        readfile($path);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['error' => 'That request is not supported.'], 405);
    }

    if ($action === 'upload') {
        require_room();
        require_csrf_header();

        $file = $_FILES['attachment'] ?? null;
        if (!is_array($file) || !isset($file['error'], $file['tmp_name'], $file['size'], $file['name'])) {
            respond(['error' => 'Choose an image or file to attach.'], 422);
        }
        if ($file['error'] !== UPLOAD_ERR_OK) {
            $uploadErrors = [
                UPLOAD_ERR_INI_SIZE => 'The file exceeds the server upload limit.',
                UPLOAD_ERR_FORM_SIZE => 'The file is too large.',
                UPLOAD_ERR_PARTIAL => 'The file did not finish uploading. Try again.',
                UPLOAD_ERR_NO_FILE => 'Choose an image or file to attach.',
                UPLOAD_ERR_NO_TMP_DIR => 'The server upload folder is unavailable.',
                UPLOAD_ERR_CANT_WRITE => 'The server could not save the upload.',
                UPLOAD_ERR_EXTENSION => 'The server blocked this upload.',
            ];
            $status = in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) ? 413 : 422;
            respond(['error' => $uploadErrors[$file['error']] ?? 'The upload failed. Try again.'], $status);
        }

        $maximumSize = 10 * 1024 * 1024;
        if (!is_int($file['size']) || $file['size'] < 1 || $file['size'] > $maximumSize) {
            respond(['error' => 'Files must be smaller than 10 MB.'], 413);
        }
        if (!is_uploaded_file($file['tmp_name'])) {
            respond(['error' => 'The uploaded file could not be verified.'], 422);
        }

        $caption = trim(is_string($_POST['message'] ?? null) ? $_POST['message'] : '');
        if (mb_strlen($caption) > 2000) {
            respond(['error' => 'Messages must be 2,000 characters or fewer.'], 422);
        }

        $originalName = basename(str_replace('\\', '/', (string) $file['name']));
        $originalName = preg_replace('/[\x00-\x1F\x7F]/u', '', $originalName) ?: 'attachment';
        if (mb_strlen($originalName) > 255) {
            respond(['error' => 'File names must be 255 characters or fewer.'], 422);
        }

        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $mimeType = $finfo->file($file['tmp_name']);
        $allowedTypes = [
            'image/jpeg' => ['jpg', 'jpeg'],
            'image/png' => ['png'],
            'image/gif' => ['gif'],
            'image/webp' => ['webp'],
            'application/pdf' => ['pdf'],
            'text/plain' => ['txt', 'csv'],
            'text/csv' => ['csv'],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => ['docx'],
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => ['xlsx'],
        ];
        $extension = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        if (!is_string($mimeType) || !isset($allowedTypes[$mimeType]) || !in_array($extension, $allowedTypes[$mimeType], true)) {
            respond(['error' => 'Use JPG, PNG, GIF, WEBP, PDF, TXT, CSV, DOCX, or XLSX files.'], 415);
        }

        $directory = upload_directory();
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new RuntimeException('Could not create attachment storage directory.');
        }

        $storageKey = bin2hex(random_bytes(32));
        $destination = $directory . DIRECTORY_SEPARATOR . $storageKey;
        if (!move_uploaded_file($file['tmp_name'], $destination)) {
            throw new RuntimeException('Could not move uploaded attachment into storage.');
        }

        try {
            $pdo = db();
            $pdo->beginTransaction();
            $messageStatement = $pdo->prepare('INSERT INTO messages (room_id, sender, body) VALUES (?, ?, ?)');
            $messageStatement->execute([(int) $_SESSION['room_id'], $_SESSION['nickname'], $caption]);
            $messageId = (int) $pdo->lastInsertId();

            $attachmentStatement = $pdo->prepare(
                'INSERT INTO attachments (message_id, storage_key, original_name, mime_type, file_size)
                 VALUES (?, ?, ?, ?, ?)'
            );
            $attachmentStatement->execute([$messageId, $storageKey, $originalName, $mimeType, $file['size']]);
            $pdo->commit();
        } catch (Throwable $error) {
            if (isset($pdo) && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            if (is_file($destination)) {
                unlink($destination);
            }
            throw $error;
        }

        respond(['ok' => true]);
    }

    $data = input_data();
    require_csrf($data);

    if ($action === 'create_room') {
        $nickname = valid_nickname($data['name'] ?? null);
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $pdo = db();
        $statement = $pdo->prepare('INSERT INTO rooms (invite_code) VALUES (?)');

        do {
            $code = '';
            for ($i = 0; $i < 8; $i++) {
                $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            try {
                $statement->execute([$code]);
            } catch (PDOException $error) {
                if ($error->getCode() !== '23000') {
                    throw $error;
                }
                $code = '';
            }
        } while ($code === '');

        session_regenerate_id(true);
        $_SESSION['room_id'] = (int) $pdo->lastInsertId();
        $_SESSION['room_code'] = $code;
        $_SESSION['nickname'] = $nickname;
        respond(['room' => ['code' => $code, 'nickname' => $nickname]]);
    }

    if ($action === 'join_room') {
        $nickname = valid_nickname($data['name'] ?? null);
        $code = strtoupper(trim(is_string($data['code'] ?? null) ? $data['code'] : ''));
        if (!preg_match('/^[A-HJ-NP-Z2-9]{8}$/', $code)) {
            respond(['error' => 'Enter a valid 8-character room code.'], 422);
        }

        $statement = db()->prepare('SELECT id, invite_code FROM rooms WHERE invite_code = ?');
        $statement->execute([$code]);
        $room = $statement->fetch();
        if (!$room) {
            respond(['error' => 'We couldn’t find that room. Check the code and try again.'], 404);
        }

        session_regenerate_id(true);
        $_SESSION['room_id'] = (int) $room['id'];
        $_SESSION['room_code'] = $room['invite_code'];
        $_SESSION['nickname'] = $nickname;
        respond(['room' => ['code' => $room['invite_code'], 'nickname' => $nickname]]);
    }

    if ($action === 'send') {
        $roomId = require_room();
        $message = trim(is_string($data['message'] ?? null) ? $data['message'] : '');
        if ($message === '' || mb_strlen($message) > 2000) {
            respond(['error' => 'Messages must be between 1 and 2,000 characters.'], 422);
        }

        $statement = db()->prepare('INSERT INTO messages (room_id, sender, body) VALUES (?, ?, ?)');
        $statement->execute([$roomId, $_SESSION['nickname'], $message]);
        respond(['ok' => true]);
    }

    if ($action === 'leave') {
        unset($_SESSION['room_id'], $_SESSION['room_code'], $_SESSION['nickname']);
        respond(['ok' => true]);
    }

    respond(['error' => 'That action is not available.'], 404);
} catch (Throwable $error) {
    error_log('Quiet Chat API error: ' . $error->getMessage());
    respond(['error' => 'The chat service is unavailable. Check that MySQL is running and the database is set up.'], 503);
}
