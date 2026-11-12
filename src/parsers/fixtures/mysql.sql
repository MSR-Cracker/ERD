CREATE TABLE `clients` (
  `client_id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `phone` VARCHAR(32) NULL,
  PRIMARY KEY (`client_id`),
  UNIQUE KEY `clients_name_unique` (`name`)
);

CREATE TABLE `orders` (
  `order_id` BIGINT NOT NULL AUTO_INCREMENT,
  `client_id` BIGINT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`order_id`),
  CONSTRAINT `orders_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`client_id`) ON DELETE CASCADE ON UPDATE CASCADE
);
