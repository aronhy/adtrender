-- Prisma DateTime uses UTC values in timestamp-without-time-zone columns.
-- Ensure defaults and database worker clocks use the same convention.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L',current_database(),'UTC');
END $$;
