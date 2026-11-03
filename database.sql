CREATE DATABASE IF NOT EXISTS quiet_chat
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE quiet_chat;

CREATE TABLE IF NOT EXISTS rooms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invite_code CHAR(8) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rooms_invite_code (invite_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id BIGINT UNSIGNED NOT NULL,
  sender VARCHAR(30) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_room_id_id (room_id, id),
  CONSTRAINT fk_messages_room
    FOREIGN KEY (room_id) REFERENCES rooms (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attachments (
  message_id BIGINT UNSIGNED NOT NULL,
  storage_key CHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(127) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  PRIMARY KEY (message_id),
  UNIQUE KEY uq_attachments_storage_key (storage_key),
  CONSTRAINT fk_attachments_message
    FOREIGN KEY (message_id) REFERENCES messages (id)
    ON DELETE CASCADE
) ENGINE=InnoDB;
