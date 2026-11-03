<?php
declare(strict_types=1);

function db(): PDO
{
    static $connection = null;

    if ($connection instanceof PDO) {
        return $connection;
    }

    $host = getenv('CHAT_DB_HOST') ?: '127.0.0.1';
    $database = getenv('CHAT_DB_NAME') ?: 'quiet_chat';
    $username = getenv('CHAT_DB_USER') ?: 'root';
    $password = getenv('CHAT_DB_PASSWORD') ?: '';

    $connection = new PDO(
        "mysql:host={$host};dbname={$database};charset=utf8mb4",
        $username,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );

    return $connection;
}

function start_app_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    session_set_cookie_params([
        'httponly' => true,
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'samesite' => 'Lax',
    ]);
    session_start();
}

function upload_directory(): string
{
    $configured = getenv('CHAT_UPLOAD_DIR');
    return $configured ?: dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'chat_uploads';
}
