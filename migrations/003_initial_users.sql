-- 003_initial_users.sql
-- The ten initial profiles of the demo user directory (all fictional).
--
-- Emails are PLACEHOLDERS on the reserved `.invalid` domain (RFC 2606): they
-- are not real addresses and cannot receive mail. password_hash is NULL, so
-- none of these accounts can sign in until credentials are set — with
-- `npm run db:set-credentials`, or `npm run db:seed-demo` for a demo database.
-- No password, plain or hashed, is ever stored in a migration.

INSERT INTO users (full_name, email, role) VALUES
  ('Maya',   'maya.placeholder@example.invalid',   'student'),
  ('Omar',   'omar.placeholder@example.invalid',   'student'),
  ('Lena',   'lena.placeholder@example.invalid',   'student'),
  ('Daniel', 'daniel.placeholder@example.invalid', 'student'),
  ('Sofia',  'sofia.placeholder@example.invalid',  'student'),
  ('Kenji',  'kenji.placeholder@example.invalid',  'student'),
  ('Priya',  'priya.placeholder@example.invalid',  'admin'),
  ('James',  'james.placeholder@example.invalid',  'admin'),
  ('Nadia',  'nadia.placeholder@example.invalid',  'admin'),
  ('Elena',  'elena.placeholder@example.invalid',  'admin')
ON CONFLICT (email) DO NOTHING;
