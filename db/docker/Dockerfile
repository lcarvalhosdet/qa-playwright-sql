# PostgreSQL 16 with pgTAP, for the SQL tests in db/tests.
# The official image already has the PostgreSQL apt repository (apt.postgresql.org)
# configured, which packages pgTAP for each server version.
FROM postgres:16

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgtap \
 && rm -rf /var/lib/apt/lists/*
