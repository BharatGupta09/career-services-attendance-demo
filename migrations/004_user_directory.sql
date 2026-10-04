-- 004_user_directory.sql
-- Replace the ten placeholder profiles from 003 with the full directory entries
-- (names and email addresses). In this public demo every person is fictional
-- and every address is on the reserved example.com domain. No password is set
-- here: password_hash stays NULL until credentials are set, and no password,
-- plain or hashed, is ever stored in a migration.
--
-- Rows are matched by their placeholder email, so re-running is harmless, and
-- the checks at the end abort the migration if the result is not exactly the
-- ten intended users.

UPDATE users AS u
SET full_name = v.full_name,
    email     = v.email,
    role      = v.role,
    is_active = true
FROM (VALUES
  ('maya.placeholder@example.invalid',   'Maya Thompson',  'maya.thompson@example.com',  'student'),
  ('omar.placeholder@example.invalid',   'Omar Haddad',    'omar.haddad@example.com',    'student'),
  ('lena.placeholder@example.invalid',   'Lena Fischer',   'lena.fischer@example.com',   'student'),
  ('daniel.placeholder@example.invalid', 'Daniel Okafor',  'daniel.okafor@example.com',  'student'),
  ('sofia.placeholder@example.invalid',  'Sofia Marquez',  'sofia.marquez@example.com',  'student'),
  ('kenji.placeholder@example.invalid',  'Kenji Watanabe', 'kenji.watanabe@example.com', 'student'),
  ('priya.placeholder@example.invalid',  'Priya Raman',    'priya.raman@example.com',    'admin'),
  ('james.placeholder@example.invalid',  'James Carter',   'james.carter@example.com',   'admin'),
  ('nadia.placeholder@example.invalid',  'Nadia Hassan',   'nadia.hassan@example.com',   'admin'),
  ('elena.placeholder@example.invalid',  'Elena Rossi',    'elena.rossi@example.com',    'admin')
) AS v (placeholder, full_name, email, role)
WHERE u.email = v.placeholder;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email LIKE '%@example.invalid') THEN
    RAISE EXCEPTION 'placeholder users remain after 004_user_directory';
  END IF;
  IF (SELECT count(*) FROM users WHERE is_active AND role = 'student') <> 6
     OR (SELECT count(*) FROM users WHERE is_active AND role = 'admin') <> 4
     OR (SELECT count(*) FROM users) <> 10 THEN
    RAISE EXCEPTION 'expected exactly 6 active students and 4 active admins after 004_user_directory';
  END IF;
END;
$$;
