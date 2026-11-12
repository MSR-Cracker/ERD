CREATE TABLE branches (
  branch_id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE staff (
  staff_id BIGSERIAL NOT NULL,
  branch_id BIGINT NOT NULL REFERENCES branches(branch_id) ON DELETE RESTRICT,
  full_name TEXT NOT NULL,
  PRIMARY KEY (staff_id, branch_id)
);
