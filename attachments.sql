USE quiet_chat;

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
