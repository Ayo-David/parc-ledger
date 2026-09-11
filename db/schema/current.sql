--
-- PostgreSQL database dump
--

-- Dumped from database version 14.18 (Homebrew)
-- Dumped by pg_dump version 14.18 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: account_nature; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_nature AS ENUM (
    'DEBIT',
    'CREDIT'
);


--
-- Name: adjustment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.adjustment_status AS ENUM (
    'PENDING',
    'APPROVED',
    'POSTED',
    'REJECTED',
    'CANCELLED'
);


--
-- Name: entry_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entry_type AS ENUM (
    'DEBIT',
    'CREDIT'
);


--
-- Name: hold_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.hold_status AS ENUM (
    'ACTIVE',
    'RELEASED',
    'EXPIRED',
    'CANCELLED'
);


--
-- Name: journal_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.journal_status AS ENUM (
    'DRAFT',
    'PENDING',
    'POSTED',
    'REVERSED',
    'VOIDED'
);


--
-- Name: ledger_account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_account_status AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'SUSPENDED',
    'CLOSED'
);


--
-- Name: ledger_account_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_account_type AS ENUM (
    'ASSET',
    'LIABILITY',
    'EQUITY',
    'INCOME',
    'EXPENSE'
);


--
-- Name: ledger_book_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_book_status AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'CLOSED'
);


--
-- Name: ledger_entity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_entity_type AS ENUM (
    'PLATFORM',
    'TENANT',
    'PROVIDER',
    'BANK',
    'OTHER'
);


--
-- Name: ledger_event_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_event_status AS ENUM (
    'RECEIVED',
    'PROCESSING',
    'PROCESSED',
    'FAILED',
    'IGNORED'
);


--
-- Name: ledger_outbox_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ledger_outbox_status AS ENUM (
    'PENDING',
    'PUBLISHED',
    'FAILED'
);


--
-- Name: period_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.period_status AS ENUM (
    'OPEN',
    'CLOSING',
    'CLOSED',
    'LOCKED'
);


--
-- Name: reconciliation_item_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reconciliation_item_status AS ENUM (
    'MATCHED',
    'UNMATCHED',
    'EXCEPTION',
    'RESOLVED',
    'IGNORED'
);


--
-- Name: reconciliation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reconciliation_status AS ENUM (
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'PARTIAL'
);


--
-- Name: settlement_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.settlement_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'SETTLED',
    'FAILED',
    'PARTIALLY_SETTLED',
    'REVERSED'
);


--
-- Name: transaction_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transaction_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'REVERSED',
    'CANCELLED'
);


--
-- Name: transaction_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transaction_type AS ENUM (
    'TRANSFER',
    'DEPOSIT',
    'WITHDRAWAL',
    'PAYMENT',
    'LOAN_DISBURSEMENT',
    'LOAN_REPAYMENT',
    'SAVINGS_DEPOSIT',
    'SAVINGS_WITHDRAWAL',
    'FIXED_DEPOSIT',
    'FIXED_DEPOSIT_MATURITY',
    'INTEREST_ACCRUAL',
    'INTEREST_PAYMENT',
    'FEE',
    'REFUND',
    'REVERSAL',
    'TAX',
    'ADJUSTMENT',
    'REFERRAL_REWARD',
    'BILL_PAYMENT',
    'PLATFORM_REVENUE_EARNED',
    'PLATFORM_REVENUE_SETTLEMENT',
    'PLATFORM_REVENUE_ADJUSTMENT',
    'PLATFORM_REVENUE_REVERSAL',
    'OTHER'
);


--
-- Name: current_tenant_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT NULLIF(
        current_setting(
            'app.current_tenant_id',
            true
        ),
        ''
    )::UUID;
$$;


--
-- Name: journal_posting_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.journal_posting_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_total_debits NUMERIC(20,2);
    v_total_credits NUMERIC(20,2);
BEGIN
    IF NEW.status = 'POSTED'
       AND OLD.status <> 'POSTED' THEN

        PERFORM validate_journal_balance(NEW.id);

        SELECT total_debits, total_credits
        INTO v_total_debits, v_total_credits
        FROM journals
        WHERE id = NEW.id;

        NEW.total_debits = v_total_debits;
        NEW.total_credits = v_total_credits;

        NEW.posted_at = COALESCE(
            NEW.posted_at,
            NOW()
        );
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: post_journal(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_journal(p_journal_id uuid, p_actor_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status journal_status;
    v_period_status period_status;
    v_period_id UUID;
    v_journal_book UUID;
    v_period_book UUID;
    v_transaction_book UUID;
    v_transaction_id UUID;
BEGIN
    SELECT
        status,
        accounting_period_id,
        book_id,
        transaction_id
    INTO
        v_status,
        v_period_id,
        v_journal_book,
        v_transaction_id
    FROM journals
    WHERE id = p_journal_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Journal % does not exist.',
            p_journal_id;
    END IF;

    IF v_status NOT IN ('DRAFT', 'PENDING') THEN
        RAISE EXCEPTION
            'Journal % cannot be posted from status %.',
            p_journal_id,
            v_status;
    END IF;

    IF v_period_id IS NOT NULL THEN
        SELECT status, book_id
        INTO v_period_status, v_period_book
        FROM accounting_periods
        WHERE id = v_period_id;

        IF v_period_status <> 'OPEN' THEN
            RAISE EXCEPTION
                'Accounting period is not open.';
        END IF;

        IF v_period_book <> v_journal_book THEN
            RAISE EXCEPTION
                'Journal and accounting period belong to different books.';
        END IF;
    END IF;

    IF v_transaction_id IS NOT NULL THEN
        SELECT book_id
        INTO v_transaction_book
        FROM ledger_transactions
        WHERE id = v_transaction_id;

        IF v_transaction_book <> v_journal_book THEN
            RAISE EXCEPTION
                'Journal and ledger transaction belong to different books.';
        END IF;
    END IF;

    PERFORM validate_journal_balance(p_journal_id);

    UPDATE journals
    SET
        status = 'POSTED',
        posted_at = NOW(),
        posted_by = p_actor_id
    WHERE id = p_journal_id;

    IF v_transaction_id IS NOT NULL THEN
        UPDATE ledger_transactions
        SET
            status = 'COMPLETED',
            completed_at = COALESCE(completed_at, NOW())
        WHERE id = v_transaction_id
          AND status IN ('PENDING', 'PROCESSING');
    END IF;
END;
$$;


--
-- Name: prevent_posted_journal_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_posted_journal_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status IN ('POSTED', 'REVERSED') THEN
        RAISE EXCEPTION
            'Posted/reversed journals cannot be deleted.';
    END IF;

    RETURN OLD;
END;
$$;


--
-- Name: prevent_posted_journal_entry_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_posted_journal_entry_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_status journal_status;
BEGIN

    SELECT status
    INTO current_status
    FROM journals
    WHERE id = OLD.journal_id;

    IF current_status IN ('POSTED', 'REVERSED') THEN

        RAISE EXCEPTION
            'Posted/reversed journal entries are immutable. Use a new reversal or adjustment instead.';

    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: prevent_posted_journal_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_posted_journal_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF OLD.status = 'POSTED' THEN

        IF NEW.status <> 'REVERSED'
           AND NEW.status <> 'POSTED' THEN

            RAISE EXCEPTION
                'Posted journal can only remain POSTED or be REVERSED.';

        END IF;

        IF NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.total_debits IS DISTINCT FROM OLD.total_debits
           OR NEW.total_credits IS DISTINCT FROM OLD.total_credits
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
           OR NEW.book_id IS DISTINCT FROM OLD.book_id
           OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN

            RAISE EXCEPTION
                'Posted journal financial fields are immutable.';

        END IF;

    END IF;

    RETURN NEW;

END;
$$;


--
-- Name: refresh_ledger_account_balance(uuid, character); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_ledger_account_balance(p_account_id uuid, p_currency character) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_debit NUMERIC(20,2);
    v_credit NUMERIC(20,2);
    v_normal_balance account_nature;
    v_balance NUMERIC(20,2);
    v_held NUMERIC(20,2);
    v_last_entry UUID;
BEGIN
    SELECT normal_balance
    INTO v_normal_balance
    FROM ledger_accounts
    WHERE id = p_account_id
      AND status = 'ACTIVE'
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active ledger account % does not exist.',
            p_account_id;
    END IF;

    SELECT
        COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN je.entry_type = 'CREDIT' THEN je.amount ELSE 0 END), 0)
    INTO
        v_debit,
        v_credit
    FROM journal_entries je
    INNER JOIN journals j
        ON j.id = je.journal_id
    WHERE je.account_id = p_account_id
      AND je.currency_code = p_currency
      AND j.status = 'POSTED';

    SELECT je.id
    INTO v_last_entry
    FROM journal_entries je
    INNER JOIN journals j
        ON j.id = je.journal_id
    WHERE je.account_id = p_account_id
      AND je.currency_code = p_currency
      AND j.status = 'POSTED'
    ORDER BY j.posted_at DESC NULLS LAST,
             je.created_at DESC,
             je.entry_sequence DESC
    LIMIT 1;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_held
    FROM account_holds
    WHERE account_id = p_account_id
      AND currency_code = p_currency
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW());

    v_balance :=
        CASE
            WHEN v_normal_balance = 'DEBIT'
            THEN v_debit - v_credit
            ELSE v_credit - v_debit
        END;

    INSERT INTO ledger_account_balances (
        tenant_id,
        account_id,
        currency_code,
        posted_debit,
        posted_credit,
        balance,
        available_balance,
        held_balance,
        last_entry_id,
        version,
        calculated_at,
        updated_at
    )
    SELECT
        la.tenant_id,
        p_account_id,
        p_currency,
        v_debit,
        v_credit,
        v_balance,
        v_balance - v_held,
        v_held,
        v_last_entry,
        1,
        NOW(),
        NOW()
    FROM ledger_accounts la
    WHERE la.id = p_account_id
    ON CONFLICT (account_id, currency_code)
    DO UPDATE SET
        posted_debit = EXCLUDED.posted_debit,
        posted_credit = EXCLUDED.posted_credit,
        balance = EXCLUDED.balance,
        available_balance = EXCLUDED.available_balance,
        held_balance = EXCLUDED.held_balance,
        last_entry_id = EXCLUDED.last_entry_id,
        version = ledger_account_balances.version + 1,
        calculated_at = NOW(),
        updated_at = NOW();
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: validate_journal_balance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_journal_balance(p_journal_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_debits NUMERIC(20,2);
    v_credits NUMERIC(20,2);
    v_entry_count INTEGER;
    v_journal_currency CHAR(3);
    v_journal_tenant UUID;
    v_journal_book UUID;
    v_invalid_scope_count INTEGER;
BEGIN
    SELECT
        currency_code,
        tenant_id,
        book_id
    INTO
        v_journal_currency,
        v_journal_tenant,
        v_journal_book
    FROM journals
    WHERE id = p_journal_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Journal % does not exist.',
            p_journal_id;
    END IF;

    SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0),
        COUNT(*)
    INTO
        v_debits,
        v_credits,
        v_entry_count
    FROM journal_entries
    WHERE journal_id = p_journal_id;

    IF v_entry_count < 2 THEN
        RAISE EXCEPTION
            'Journal % must contain at least two entries.',
            p_journal_id;
    END IF;

    SELECT COUNT(*)
    INTO v_invalid_scope_count
    FROM journal_entries je
    INNER JOIN ledger_accounts la
        ON la.id = je.account_id
    WHERE je.journal_id = p_journal_id
      AND (
            je.tenant_id <> v_journal_tenant
         OR la.tenant_id <> v_journal_tenant
         OR la.book_id <> v_journal_book
         OR je.currency_code <> v_journal_currency
         OR la.currency_code <> v_journal_currency
         OR la.status <> 'ACTIVE'
         OR la.deleted_at IS NOT NULL
      );

    IF v_invalid_scope_count > 0 THEN
        RAISE EXCEPTION
            'Journal % contains entries/accounts outside its tenant, book or currency scope, or uses inactive accounts.',
            p_journal_id;
    END IF;

    IF v_debits <> v_credits THEN
        RAISE EXCEPTION
            'Unbalanced journal %. Debits: %, Credits: %.',
            p_journal_id,
            v_debits,
            v_credits;
    END IF;

    UPDATE journals
    SET
        total_debits = v_debits,
        total_credits = v_credits
    WHERE id = p_journal_id;
END;
$$;


--
-- Name: validate_journal_book_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_journal_book_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_book_tenant UUID;
BEGIN
    SELECT tenant_id
    INTO v_book_tenant
    FROM ledger_books
    WHERE id = NEW.book_id
      AND status = 'ACTIVE'
      AND deleted_at IS NULL;

    IF v_book_tenant IS NULL THEN
        RAISE EXCEPTION
            'Active ledger book % does not exist.',
            NEW.book_id;
    END IF;

    IF v_book_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION
            'Journal tenant does not match ledger book tenant.';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: validate_ledger_account_book_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_ledger_account_book_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_book_tenant UUID;
BEGIN
    SELECT tenant_id
    INTO v_book_tenant
    FROM ledger_books
    WHERE id = NEW.book_id
      AND status = 'ACTIVE'
      AND deleted_at IS NULL;

    IF v_book_tenant IS NULL THEN
        RAISE EXCEPTION
            'Active ledger book % does not exist.',
            NEW.book_id;
    END IF;

    IF v_book_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION
            'Ledger account tenant does not match ledger book tenant.';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: validate_ledger_book_entity_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_ledger_book_entity_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_entity_tenant UUID;
    v_is_platform BOOLEAN;
    v_entity_status ledger_book_status;
BEGIN
    SELECT tenant_id, is_platform, status
    INTO v_entity_tenant, v_is_platform, v_entity_status
    FROM ledger_entities
    WHERE id = NEW.entity_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Ledger entity % does not exist.',
            NEW.entity_id;
    END IF;

    IF v_entity_status <> 'ACTIVE' THEN
        RAISE EXCEPTION
            'Ledger entity % is not ACTIVE.',
            NEW.entity_id;
    END IF;

    IF v_is_platform = FALSE
       AND v_entity_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION
            'Non-platform ledger book tenant must match its ledger entity tenant.';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: validate_ledger_transaction_book_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_ledger_transaction_book_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_book_tenant UUID;
BEGIN
    SELECT tenant_id
    INTO v_book_tenant
    FROM ledger_books
    WHERE id = NEW.book_id
      AND status = 'ACTIVE'
      AND deleted_at IS NULL;

    IF v_book_tenant IS NULL THEN
        RAISE EXCEPTION
            'Active ledger book % does not exist.',
            NEW.book_id;
    END IF;

    IF v_book_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION
            'Ledger transaction tenant does not match ledger book tenant.';
    END IF;

    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_hold_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_hold_releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    reason text,
    released_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hold_release_amount_chk CHECK ((amount > (0)::numeric))
);


--
-- Name: account_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    hold_reference character varying(100) NOT NULL,
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    status public.hold_status DEFAULT 'ACTIVE'::public.hold_status NOT NULL,
    reason character varying(255) NOT NULL,
    source_service character varying(100),
    source_reference character varying(255),
    expires_at timestamp with time zone,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    released_by uuid,
    CONSTRAINT account_hold_amount_chk CHECK ((amount > (0)::numeric))
);


--
-- Name: accounting_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounting_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    period_code character varying(20) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status public.period_status DEFAULT 'OPEN'::public.period_status NOT NULL,
    closed_at timestamp with time zone,
    closed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounting_period_dates_chk CHECK ((end_date >= start_date))
);


--
-- Name: customer_balance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_balance_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    ledger_account_id uuid NOT NULL,
    snapshot_date date NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    balance numeric(20,2) NOT NULL,
    available_balance numeric(20,2) NOT NULL,
    held_balance numeric(20,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_ledger_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_ledger_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    ledger_account_id uuid NOT NULL,
    account_purpose character varying(100) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    status public.ledger_account_status DEFAULT 'ACTIVE'::public.ledger_account_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    journal_id uuid NOT NULL,
    account_id uuid NOT NULL,
    entry_type public.entry_type NOT NULL,
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    entry_sequence integer NOT NULL,
    description text,
    reference character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT journal_entry_amount_chk CHECK ((amount > (0)::numeric)),
    CONSTRAINT journal_entry_sequence_chk CHECK ((entry_sequence > 0))
);


--
-- Name: journal_entry_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entry_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    journal_entry_id uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    journal_reference character varying(100) NOT NULL,
    transaction_id uuid,
    accounting_period_id uuid,
    status public.journal_status DEFAULT 'DRAFT'::public.journal_status NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    total_debits numeric(20,2) DEFAULT 0 NOT NULL,
    total_credits numeric(20,2) DEFAULT 0 NOT NULL,
    description text,
    posted_at timestamp with time zone,
    posted_by uuid,
    reversed_at timestamp with time zone,
    reversed_by uuid,
    reversal_journal_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT journal_totals_chk CHECK (((total_debits >= (0)::numeric) AND (total_credits >= (0)::numeric)))
);


--
-- Name: ledger_account_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_account_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    posted_debit numeric(20,2) DEFAULT 0 NOT NULL,
    posted_credit numeric(20,2) DEFAULT 0 NOT NULL,
    balance numeric(20,2) DEFAULT 0 NOT NULL,
    available_balance numeric(20,2) DEFAULT 0 NOT NULL,
    held_balance numeric(20,2) DEFAULT 0 NOT NULL,
    last_entry_id uuid,
    version bigint DEFAULT 0 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT balance_amounts_chk CHECK (((posted_debit >= (0)::numeric) AND (posted_credit >= (0)::numeric) AND (held_balance >= (0)::numeric)))
);


--
-- Name: ledger_account_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_account_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    code character varying(50) NOT NULL,
    name character varying(150) NOT NULL,
    account_type public.ledger_account_type NOT NULL,
    parent_category_id uuid,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);


--
-- Name: ledger_account_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_account_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    minimum_balance numeric(20,2),
    maximum_balance numeric(20,2),
    daily_debit_limit numeric(20,2),
    daily_credit_limit numeric(20,2),
    monthly_debit_limit numeric(20,2),
    monthly_credit_limit numeric(20,2),
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_limits_chk CHECK ((((minimum_balance IS NULL) OR (minimum_balance >= (0)::numeric)) AND ((maximum_balance IS NULL) OR (maximum_balance >= (0)::numeric)) AND ((daily_debit_limit IS NULL) OR (daily_debit_limit >= (0)::numeric)) AND ((daily_credit_limit IS NULL) OR (daily_credit_limit >= (0)::numeric)) AND ((monthly_debit_limit IS NULL) OR (monthly_debit_limit >= (0)::numeric)) AND ((monthly_credit_limit IS NULL) OR (monthly_credit_limit >= (0)::numeric))))
);


--
-- Name: ledger_account_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_account_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    event_code character varying(100) NOT NULL,
    debit_account_id uuid,
    credit_account_id uuid,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);


--
-- Name: ledger_account_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_account_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    normal_balance public.account_nature NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);


--
-- Name: ledger_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    account_code character varying(50) NOT NULL,
    account_name character varying(200) NOT NULL,
    account_type public.ledger_account_type NOT NULL,
    category_id uuid,
    parent_account_id uuid,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    normal_balance public.account_nature NOT NULL,
    status public.ledger_account_status DEFAULT 'ACTIVE'::public.ledger_account_status NOT NULL,
    is_control_account boolean DEFAULT false NOT NULL,
    is_customer_account boolean DEFAULT false NOT NULL,
    is_system_account boolean DEFAULT false NOT NULL,
    external_reference character varying(255),
    description text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT ledger_account_currency_chk CHECK ((currency_code ~ '^[A-Z]{3}$'::text))
);


--
-- Name: ledger_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    entity_type character varying(100) NOT NULL,
    entity_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    actor_id uuid,
    service_name character varying(100),
    ip_address inet,
    before_data jsonb,
    after_data jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_books; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_books (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    book_code character varying(100) NOT NULL,
    book_name character varying(200) NOT NULL,
    base_currency character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    status public.ledger_book_status DEFAULT 'ACTIVE'::public.ledger_book_status NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT ledger_book_currency_chk CHECK ((base_currency ~ '^[A-Z]{3}$'::text))
);


--
-- Name: TABLE ledger_books; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ledger_books IS 'Accounting books scoped by tenant and legal/accounting entity. All ledger postings belong to exactly one book.';


--
-- Name: ledger_control_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_control_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    account_id uuid NOT NULL,
    control_type character varying(100) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    entity_code character varying(100) NOT NULL,
    entity_name character varying(200) NOT NULL,
    entity_type public.ledger_entity_type NOT NULL,
    registration_number character varying(100),
    country_code character(2) DEFAULT 'NG'::bpchar NOT NULL,
    base_currency character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    is_platform boolean DEFAULT false NOT NULL,
    status public.ledger_book_status DEFAULT 'ACTIVE'::public.ledger_book_status NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT ledger_entity_country_chk CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT ledger_entity_currency_chk CHECK ((base_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ledger_entity_platform_chk CHECK ((((is_platform = true) AND (entity_type = 'PLATFORM'::public.ledger_entity_type) AND (tenant_id IS NULL)) OR (is_platform = false)))
);


--
-- Name: TABLE ledger_entities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ledger_entities IS 'Legal/accounting ownership dimension. The PARC row represents the platform entity; tenant rows represent institution entities.';


--
-- Name: ledger_fees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_fees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid,
    account_id uuid,
    fee_code character varying(100) NOT NULL,
    fee_description character varying(255),
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    tax_amount numeric(20,2) DEFAULT 0 NOT NULL,
    net_amount numeric(20,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_fee_amount_chk CHECK (((amount >= (0)::numeric) AND (tax_amount >= (0)::numeric) AND (net_amount >= (0)::numeric)))
);


--
-- Name: ledger_inbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_inbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    source_service character varying(100) NOT NULL,
    event_id uuid NOT NULL,
    event_type character varying(150) NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    aggregate_type character varying(100),
    aggregate_id uuid,
    idempotency_key character varying(255),
    correlation_id uuid,
    causation_id uuid,
    payload jsonb NOT NULL,
    status public.ledger_event_status DEFAULT 'RECEIVED'::public.ledger_event_status NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_started_at timestamp with time zone,
    processed_at timestamp with time zone,
    last_error text,
    ledger_transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_inbox_retry_chk CHECK ((retry_count >= 0)),
    CONSTRAINT ledger_inbox_version_chk CHECK ((event_version > 0))
);


--
-- Name: TABLE ledger_inbox_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ledger_inbox_events IS 'Consumer-side event deduplication and processing state for external events received by Ledger Service.';


--
-- Name: ledger_integrity_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_integrity_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    check_type character varying(100) NOT NULL,
    check_date date NOT NULL,
    status character varying(30) NOT NULL,
    records_checked bigint DEFAULT 0 NOT NULL,
    records_failed bigint DEFAULT 0 NOT NULL,
    total_debits numeric(20,2) DEFAULT 0 NOT NULL,
    total_credits numeric(20,2) DEFAULT 0 NOT NULL,
    discrepancy_amount numeric(20,2) DEFAULT 0 NOT NULL,
    failure_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integrity_records_chk CHECK (((records_checked >= 0) AND (records_failed >= 0)))
);


--
-- Name: ledger_interest_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_interest_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid,
    account_id uuid NOT NULL,
    source_service character varying(100) NOT NULL,
    source_reference character varying(255),
    interest_type character varying(50) NOT NULL,
    principal_amount numeric(20,2) NOT NULL,
    interest_rate numeric(12,6),
    interest_amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    accrual_date date NOT NULL,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interest_amount_chk CHECK (((principal_amount >= (0)::numeric) AND (interest_amount >= (0)::numeric)))
);


--
-- Name: ledger_outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    aggregate_type character varying(100) NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type character varying(150) NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    payload jsonb NOT NULL,
    idempotency_key character varying(255),
    correlation_id uuid,
    causation_id uuid,
    status public.ledger_outbox_status DEFAULT 'PENDING'::public.ledger_outbox_status NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_outbox_retry_chk CHECK ((retry_count >= 0)),
    CONSTRAINT ledger_outbox_version_chk CHECK ((event_version > 0))
);


--
-- Name: TABLE ledger_outbox_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ledger_outbox_events IS 'Transactional outbox used to publish ledger posting/reversal/completion events after accounting changes commit.';


--
-- Name: ledger_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    snapshot_reference character varying(100) NOT NULL,
    snapshot_date date NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    account_count bigint DEFAULT 0 NOT NULL,
    total_debits numeric(20,2) DEFAULT 0 NOT NULL,
    total_credits numeric(20,2) DEFAULT 0 NOT NULL,
    total_assets numeric(20,2) DEFAULT 0 NOT NULL,
    total_liabilities numeric(20,2) DEFAULT 0 NOT NULL,
    total_equity numeric(20,2) DEFAULT 0 NOT NULL,
    total_income numeric(20,2) DEFAULT 0 NOT NULL,
    total_expenses numeric(20,2) DEFAULT 0 NOT NULL,
    snapshot_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_snapshot_counts_chk CHECK ((account_count >= 0))
);


--
-- Name: ledger_tax_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_tax_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid,
    account_id uuid NOT NULL,
    tax_code character varying(50) NOT NULL,
    taxable_amount numeric(20,2) NOT NULL,
    tax_rate numeric(12,6),
    tax_amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    tax_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_amount_chk CHECK (((taxable_amount >= (0)::numeric) AND (tax_amount >= (0)::numeric)))
);


--
-- Name: ledger_tenant_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_tenant_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    account_id uuid NOT NULL,
    purpose character varying(100) NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid
);


--
-- Name: ledger_transaction_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_transaction_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    journal_entry_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    transaction_reference character varying(100) NOT NULL,
    transaction_type public.transaction_type NOT NULL,
    status public.transaction_status DEFAULT 'PENDING'::public.transaction_status NOT NULL,
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    idempotency_key character varying(255),
    source_service character varying(100) NOT NULL,
    source_reference character varying(255),
    source_event_type character varying(150),
    source_event_id uuid,
    source_resource_type character varying(100),
    source_resource_id uuid,
    platform_revenue_event_id uuid,
    platform_revenue_settlement_id uuid,
    correlation_id uuid,
    causation_id uuid,
    request_id uuid,
    customer_id uuid,
    user_id uuid,
    payment_id uuid,
    loan_id uuid,
    savings_account_id uuid,
    parent_transaction_id uuid,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    initiated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_transaction_amount_chk CHECK ((amount >= (0)::numeric)),
    CONSTRAINT ledger_transaction_currency_chk CHECK ((currency_code ~ '^[A-Z]{3}$'::text))
);


--
-- Name: COLUMN ledger_transactions.platform_revenue_event_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ledger_transactions.platform_revenue_event_id IS 'Logical reference to parc_payment.platform_revenue_events.id. No cross-database FK.';


--
-- Name: COLUMN ledger_transactions.platform_revenue_settlement_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ledger_transactions.platform_revenue_settlement_id IS 'Logical reference to parc_payment.platform_revenue_settlements.id. No cross-database FK.';


--
-- Name: period_closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.period_closures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    accounting_period_id uuid NOT NULL,
    closure_type character varying(50) NOT NULL,
    status public.period_status DEFAULT 'CLOSING'::public.period_status NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    performed_by uuid,
    validation_results jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: posting_batch_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posting_batch_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    posting_batch_id uuid NOT NULL,
    journal_id uuid NOT NULL,
    sequence_number integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: posting_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posting_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    book_id uuid NOT NULL,
    batch_reference character varying(100) NOT NULL,
    source_service character varying(100) NOT NULL,
    status public.journal_status DEFAULT 'PENDING'::public.journal_status NOT NULL,
    total_entries integer DEFAULT 0 NOT NULL,
    total_amount numeric(20,2) DEFAULT 0 NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT posting_batch_amount_chk CHECK ((total_amount >= (0)::numeric)),
    CONSTRAINT posting_batch_entries_chk CHECK ((total_entries >= 0))
);


--
-- Name: reconciliation_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reconciliation_item_id uuid NOT NULL,
    exception_code character varying(100) NOT NULL,
    description text NOT NULL,
    status public.reconciliation_item_status DEFAULT 'EXCEPTION'::public.reconciliation_item_status NOT NULL,
    resolution text,
    assigned_to uuid,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reconciliation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reconciliation_run_id uuid NOT NULL,
    transaction_id uuid,
    external_reference character varying(255),
    source_amount numeric(20,2),
    ledger_amount numeric(20,2),
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    status public.reconciliation_item_status DEFAULT 'UNMATCHED'::public.reconciliation_item_status NOT NULL,
    difference_amount numeric(20,2) DEFAULT 0 NOT NULL,
    matched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reconciliation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_reference character varying(100) NOT NULL,
    source_system character varying(100) NOT NULL,
    reconciliation_date date NOT NULL,
    status public.reconciliation_status DEFAULT 'PENDING'::public.reconciliation_status NOT NULL,
    total_records integer DEFAULT 0 NOT NULL,
    matched_records integer DEFAULT 0 NOT NULL,
    unmatched_records integer DEFAULT 0 NOT NULL,
    exception_records integer DEFAULT 0 NOT NULL,
    total_source_amount numeric(20,2) DEFAULT 0 NOT NULL,
    total_ledger_amount numeric(20,2) DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reconciliation_counts_chk CHECK (((total_records >= 0) AND (matched_records >= 0) AND (unmatched_records >= 0) AND (exception_records >= 0)))
);


--
-- Name: settlement_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    settlement_reference character varying(100) NOT NULL,
    provider_name character varying(100),
    settlement_account_id uuid,
    payment_id uuid,
    platform_revenue_settlement_id uuid,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    gross_amount numeric(20,2) DEFAULT 0 NOT NULL,
    fee_amount numeric(20,2) DEFAULT 0 NOT NULL,
    net_amount numeric(20,2) DEFAULT 0 NOT NULL,
    status public.settlement_status DEFAULT 'PENDING'::public.settlement_status NOT NULL,
    settlement_date date,
    initiated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT settlement_amount_chk CHECK (((gross_amount >= (0)::numeric) AND (fee_amount >= (0)::numeric) AND (net_amount >= (0)::numeric) AND (net_amount = (gross_amount - fee_amount))))
);


--
-- Name: settlement_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    settlement_batch_id uuid NOT NULL,
    transaction_id uuid,
    external_reference character varying(255),
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    status public.settlement_status DEFAULT 'PENDING'::public.settlement_status NOT NULL,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_entry_amount_chk CHECK ((amount > (0)::numeric))
);


--
-- Name: transaction_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid,
    adjustment_reference character varying(100) NOT NULL,
    amount numeric(20,2) NOT NULL,
    currency_code character(3) DEFAULT 'NGN'::bpchar NOT NULL,
    reason text NOT NULL,
    status public.adjustment_status DEFAULT 'PENDING'::public.adjustment_status NOT NULL,
    requested_by uuid,
    approved_by uuid,
    approved_at timestamp with time zone,
    posted_at timestamp with time zone,
    rejected_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adjustment_amount_chk CHECK ((amount > (0)::numeric))
);


--
-- Name: transaction_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    linked_transaction_id uuid NOT NULL,
    relationship_type character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transaction_link_self_chk CHECK ((transaction_id <> linked_transaction_id))
);


--
-- Name: transaction_reversals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_reversals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    original_transaction_id uuid NOT NULL,
    reversal_transaction_id uuid NOT NULL,
    reason text NOT NULL,
    initiated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_hold_releases account_hold_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hold_releases
    ADD CONSTRAINT account_hold_releases_pkey PRIMARY KEY (id);


--
-- Name: account_holds account_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_holds
    ADD CONSTRAINT account_holds_pkey PRIMARY KEY (id);


--
-- Name: accounting_periods accounting_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_pkey PRIMARY KEY (id);


--
-- Name: customer_balance_snapshots customer_balance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_balance_snapshots
    ADD CONSTRAINT customer_balance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: customer_ledger_accounts customer_ledger_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_ledger_accounts
    ADD CONSTRAINT customer_ledger_accounts_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_entry_metadata journal_entry_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_metadata
    ADD CONSTRAINT journal_entry_metadata_pkey PRIMARY KEY (id);


--
-- Name: journals journals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT journals_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_balances ledger_account_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_balances
    ADD CONSTRAINT ledger_account_balances_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_categories ledger_account_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_categories
    ADD CONSTRAINT ledger_account_categories_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_limits ledger_account_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_limits
    ADD CONSTRAINT ledger_account_limits_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_mappings ledger_account_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_mappings
    ADD CONSTRAINT ledger_account_mappings_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_types ledger_account_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_types
    ADD CONSTRAINT ledger_account_types_code_key UNIQUE (code);


--
-- Name: ledger_account_types ledger_account_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_types
    ADD CONSTRAINT ledger_account_types_pkey PRIMARY KEY (id);


--
-- Name: ledger_accounts ledger_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT ledger_accounts_pkey PRIMARY KEY (id);


--
-- Name: ledger_audit_logs ledger_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_audit_logs
    ADD CONSTRAINT ledger_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: ledger_books ledger_books_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_books
    ADD CONSTRAINT ledger_books_pkey PRIMARY KEY (id);


--
-- Name: ledger_control_accounts ledger_control_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_control_accounts
    ADD CONSTRAINT ledger_control_accounts_pkey PRIMARY KEY (id);


--
-- Name: ledger_entities ledger_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entities
    ADD CONSTRAINT ledger_entities_pkey PRIMARY KEY (id);


--
-- Name: ledger_fees ledger_fees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_fees
    ADD CONSTRAINT ledger_fees_pkey PRIMARY KEY (id);


--
-- Name: ledger_inbox_events ledger_inbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_inbox_events
    ADD CONSTRAINT ledger_inbox_events_pkey PRIMARY KEY (id);


--
-- Name: ledger_integrity_checks ledger_integrity_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_integrity_checks
    ADD CONSTRAINT ledger_integrity_checks_pkey PRIMARY KEY (id);


--
-- Name: ledger_interest_entries ledger_interest_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_interest_entries
    ADD CONSTRAINT ledger_interest_entries_pkey PRIMARY KEY (id);


--
-- Name: ledger_outbox_events ledger_outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_outbox_events
    ADD CONSTRAINT ledger_outbox_events_pkey PRIMARY KEY (id);


--
-- Name: ledger_snapshots ledger_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_snapshots
    ADD CONSTRAINT ledger_snapshots_pkey PRIMARY KEY (id);


--
-- Name: ledger_tax_entries ledger_tax_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tax_entries
    ADD CONSTRAINT ledger_tax_entries_pkey PRIMARY KEY (id);


--
-- Name: ledger_tenant_accounts ledger_tenant_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tenant_accounts
    ADD CONSTRAINT ledger_tenant_accounts_pkey PRIMARY KEY (id);


--
-- Name: ledger_transaction_entries ledger_transaction_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transaction_entries
    ADD CONSTRAINT ledger_transaction_entries_pkey PRIMARY KEY (id);


--
-- Name: ledger_transactions ledger_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT ledger_transactions_pkey PRIMARY KEY (id);


--
-- Name: period_closures period_closures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closures
    ADD CONSTRAINT period_closures_pkey PRIMARY KEY (id);


--
-- Name: posting_batch_items posting_batch_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batch_items
    ADD CONSTRAINT posting_batch_items_pkey PRIMARY KEY (id);


--
-- Name: posting_batches posting_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batches
    ADD CONSTRAINT posting_batches_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_exceptions reconciliation_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_exceptions
    ADD CONSTRAINT reconciliation_exceptions_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_items reconciliation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_items
    ADD CONSTRAINT reconciliation_items_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_runs reconciliation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_runs
    ADD CONSTRAINT reconciliation_runs_pkey PRIMARY KEY (id);


--
-- Name: settlement_batches settlement_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_batches
    ADD CONSTRAINT settlement_batches_pkey PRIMARY KEY (id);


--
-- Name: settlement_entries settlement_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT settlement_entries_pkey PRIMARY KEY (id);


--
-- Name: transaction_adjustments transaction_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_adjustments
    ADD CONSTRAINT transaction_adjustments_pkey PRIMARY KEY (id);


--
-- Name: transaction_links transaction_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_links
    ADD CONSTRAINT transaction_links_pkey PRIMARY KEY (id);


--
-- Name: transaction_reversals transaction_reversals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_reversals
    ADD CONSTRAINT transaction_reversals_pkey PRIMARY KEY (id);


--
-- Name: ledger_account_balances uq_account_balance; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_balances
    ADD CONSTRAINT uq_account_balance UNIQUE (account_id, currency_code);


--
-- Name: ledger_account_categories uq_account_category_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_categories
    ADD CONSTRAINT uq_account_category_code UNIQUE (tenant_id, code);


--
-- Name: account_holds uq_account_hold_reference; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_holds
    ADD CONSTRAINT uq_account_hold_reference UNIQUE (tenant_id, hold_reference);


--
-- Name: ledger_account_limits uq_account_limits; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_limits
    ADD CONSTRAINT uq_account_limits UNIQUE (account_id, currency_code);


--
-- Name: ledger_account_mappings uq_account_mapping; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_mappings
    ADD CONSTRAINT uq_account_mapping UNIQUE (book_id, event_code, currency_code);


--
-- Name: accounting_periods uq_accounting_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT uq_accounting_period UNIQUE (book_id, period_code);


--
-- Name: transaction_adjustments uq_adjustment_reference; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_adjustments
    ADD CONSTRAINT uq_adjustment_reference UNIQUE (tenant_id, adjustment_reference);


--
-- Name: posting_batch_items uq_batch_item_sequence; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batch_items
    ADD CONSTRAINT uq_batch_item_sequence UNIQUE (posting_batch_id, sequence_number);


--
-- Name: ledger_control_accounts uq_control_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_control_accounts
    ADD CONSTRAINT uq_control_account UNIQUE (tenant_id, control_type);


--
-- Name: customer_balance_snapshots uq_customer_balance_snapshot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_balance_snapshots
    ADD CONSTRAINT uq_customer_balance_snapshot UNIQUE (ledger_account_id, snapshot_date, currency_code);


--
-- Name: customer_ledger_accounts uq_customer_ledger_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_ledger_accounts
    ADD CONSTRAINT uq_customer_ledger_account UNIQUE (tenant_id, customer_id, account_purpose, currency_code);


--
-- Name: journal_entries uq_journal_entry_sequence; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT uq_journal_entry_sequence UNIQUE (journal_id, entry_sequence);


--
-- Name: journals uq_journal_reference; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT uq_journal_reference UNIQUE (book_id, journal_reference);


--
-- Name: ledger_accounts uq_ledger_account_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT uq_ledger_account_code UNIQUE (book_id, account_code);


--
-- Name: ledger_books uq_ledger_book_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_books
    ADD CONSTRAINT uq_ledger_book_code UNIQUE (tenant_id, book_code);


--
-- Name: ledger_books uq_ledger_book_entity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_books
    ADD CONSTRAINT uq_ledger_book_entity UNIQUE (tenant_id, entity_id, book_code);


--
-- Name: ledger_entities uq_ledger_entity_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entities
    ADD CONSTRAINT uq_ledger_entity_code UNIQUE (entity_code);


--
-- Name: ledger_inbox_events uq_ledger_inbox_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_inbox_events
    ADD CONSTRAINT uq_ledger_inbox_idempotency UNIQUE (tenant_id, source_service, idempotency_key);


--
-- Name: ledger_inbox_events uq_ledger_inbox_source_event; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_inbox_events
    ADD CONSTRAINT uq_ledger_inbox_source_event UNIQUE (source_service, event_id);


--
-- Name: ledger_outbox_events uq_ledger_outbox_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_outbox_events
    ADD CONSTRAINT uq_ledger_outbox_idempotency UNIQUE (tenant_id, idempotency_key);


--
-- Name: ledger_snapshots uq_ledger_snapshot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_snapshots
    ADD CONSTRAINT uq_ledger_snapshot UNIQUE (tenant_id, snapshot_reference);


--
-- Name: ledger_transactions uq_ledger_transaction_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT uq_ledger_transaction_idempotency UNIQUE (book_id, idempotency_key);


--
-- Name: ledger_transactions uq_ledger_transaction_reference; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT uq_ledger_transaction_reference UNIQUE (book_id, transaction_reference);


--
-- Name: posting_batches uq_posting_batch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batches
    ADD CONSTRAINT uq_posting_batch UNIQUE (book_id, batch_reference);


--
-- Name: reconciliation_runs uq_reconciliation_run; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_runs
    ADD CONSTRAINT uq_reconciliation_run UNIQUE (tenant_id, run_reference);


--
-- Name: settlement_batches uq_settlement_reference; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_batches
    ADD CONSTRAINT uq_settlement_reference UNIQUE (tenant_id, settlement_reference);


--
-- Name: ledger_tenant_accounts uq_tenant_account_purpose; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tenant_accounts
    ADD CONSTRAINT uq_tenant_account_purpose UNIQUE (tenant_id, purpose);


--
-- Name: ledger_transaction_entries uq_transaction_journal_entry; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transaction_entries
    ADD CONSTRAINT uq_transaction_journal_entry UNIQUE (transaction_id, journal_entry_id);


--
-- Name: transaction_links uq_transaction_link; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_links
    ADD CONSTRAINT uq_transaction_link UNIQUE (transaction_id, linked_transaction_id, relationship_type);


--
-- Name: transaction_reversals uq_transaction_reversal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_reversals
    ADD CONSTRAINT uq_transaction_reversal UNIQUE (original_transaction_id);


--
-- Name: idx_account_categories_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_categories_parent ON public.ledger_account_categories USING btree (parent_category_id);


--
-- Name: idx_account_categories_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_categories_tenant ON public.ledger_account_categories USING btree (tenant_id);


--
-- Name: idx_account_holds_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_holds_account ON public.account_holds USING btree (account_id);


--
-- Name: idx_account_holds_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_holds_active ON public.account_holds USING btree (tenant_id, status) WHERE (status = 'ACTIVE'::public.hold_status);


--
-- Name: idx_account_mappings_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_mappings_event ON public.ledger_account_mappings USING btree (tenant_id, event_code);


--
-- Name: idx_accounting_periods_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounting_periods_status ON public.accounting_periods USING btree (tenant_id, status);


--
-- Name: idx_balance_snapshots_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_snapshots_customer ON public.customer_balance_snapshots USING btree (customer_id, snapshot_date DESC);


--
-- Name: idx_control_accounts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_accounts_tenant ON public.ledger_control_accounts USING btree (tenant_id);


--
-- Name: idx_customer_ledger_accounts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_ledger_accounts_account ON public.customer_ledger_accounts USING btree (ledger_account_id);


--
-- Name: idx_customer_ledger_accounts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_ledger_accounts_customer ON public.customer_ledger_accounts USING btree (customer_id);


--
-- Name: idx_customer_ledger_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_ledger_accounts_user ON public.customer_ledger_accounts USING btree (user_id);


--
-- Name: idx_hold_releases_hold; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hold_releases_hold ON public.account_hold_releases USING btree (hold_id);


--
-- Name: idx_integrity_checks_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrity_checks_date ON public.ledger_integrity_checks USING btree (tenant_id, check_date DESC);


--
-- Name: idx_integrity_checks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrity_checks_status ON public.ledger_integrity_checks USING btree (tenant_id, status);


--
-- Name: idx_interest_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_interest_account ON public.ledger_interest_entries USING btree (account_id, accrual_date DESC);


--
-- Name: idx_interest_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_interest_source ON public.ledger_interest_entries USING btree (source_service, source_reference);


--
-- Name: idx_journal_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_entries_account ON public.journal_entries USING btree (account_id, created_at DESC);


--
-- Name: idx_journal_entries_journal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_entries_journal ON public.journal_entries USING btree (journal_id);


--
-- Name: idx_journal_entries_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_entries_tenant ON public.journal_entries USING btree (tenant_id, created_at DESC);


--
-- Name: idx_journal_entry_metadata_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journal_entry_metadata_entry ON public.journal_entry_metadata USING btree (journal_entry_id);


--
-- Name: idx_journals_book; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journals_book ON public.journals USING btree (book_id, created_at DESC);


--
-- Name: idx_journals_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journals_period ON public.journals USING btree (accounting_period_id);


--
-- Name: idx_journals_posted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journals_posted ON public.journals USING btree (tenant_id, posted_at DESC);


--
-- Name: idx_journals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journals_status ON public.journals USING btree (tenant_id, status);


--
-- Name: idx_journals_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journals_transaction ON public.journals USING btree (transaction_id);


--
-- Name: idx_ledger_account_types_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_account_types_active ON public.ledger_account_types USING btree (is_active);


--
-- Name: idx_ledger_accounts_book; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_book ON public.ledger_accounts USING btree (book_id);


--
-- Name: idx_ledger_accounts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_customer ON public.ledger_accounts USING btree (tenant_id) WHERE ((is_customer_account = true) AND (deleted_at IS NULL));


--
-- Name: idx_ledger_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_parent ON public.ledger_accounts USING btree (parent_account_id);


--
-- Name: idx_ledger_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_status ON public.ledger_accounts USING btree (tenant_id, status);


--
-- Name: idx_ledger_accounts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_tenant ON public.ledger_accounts USING btree (tenant_id);


--
-- Name: idx_ledger_accounts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_accounts_type ON public.ledger_accounts USING btree (tenant_id, account_type);


--
-- Name: idx_ledger_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_audit_actor ON public.ledger_audit_logs USING btree (actor_id, created_at DESC);


--
-- Name: idx_ledger_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_audit_entity ON public.ledger_audit_logs USING btree (tenant_id, entity_type, entity_id, created_at DESC);


--
-- Name: idx_ledger_balances_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_balances_account ON public.ledger_account_balances USING btree (account_id);


--
-- Name: idx_ledger_balances_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_balances_tenant ON public.ledger_account_balances USING btree (tenant_id);


--
-- Name: idx_ledger_books_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_books_entity ON public.ledger_books USING btree (entity_id);


--
-- Name: idx_ledger_books_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_books_tenant ON public.ledger_books USING btree (tenant_id);


--
-- Name: idx_ledger_entities_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_entities_platform ON public.ledger_entities USING btree (is_platform) WHERE ((is_platform = true) AND (deleted_at IS NULL));


--
-- Name: idx_ledger_entities_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_entities_tenant ON public.ledger_entities USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_ledger_fees_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_fees_account ON public.ledger_fees USING btree (account_id);


--
-- Name: idx_ledger_fees_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_fees_code ON public.ledger_fees USING btree (tenant_id, fee_code);


--
-- Name: idx_ledger_fees_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_fees_transaction ON public.ledger_fees USING btree (transaction_id);


--
-- Name: idx_ledger_inbox_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_inbox_correlation ON public.ledger_inbox_events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_ledger_inbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_inbox_pending ON public.ledger_inbox_events USING btree (tenant_id, status, received_at) WHERE (status = ANY (ARRAY['RECEIVED'::public.ledger_event_status, 'FAILED'::public.ledger_event_status]));


--
-- Name: idx_ledger_outbox_aggregate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_outbox_aggregate ON public.ledger_outbox_events USING btree (tenant_id, aggregate_type, aggregate_id);


--
-- Name: idx_ledger_outbox_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_outbox_correlation ON public.ledger_outbox_events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_ledger_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_outbox_pending ON public.ledger_outbox_events USING btree (available_at) WHERE (status = 'PENDING'::public.ledger_outbox_status);


--
-- Name: idx_ledger_snapshots_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_snapshots_date ON public.ledger_snapshots USING btree (tenant_id, snapshot_date DESC);


--
-- Name: idx_ledger_tenant_accounts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_tenant_accounts ON public.ledger_tenant_accounts USING btree (tenant_id);


--
-- Name: idx_ledger_transactions_book; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_book ON public.ledger_transactions USING btree (book_id, created_at DESC);


--
-- Name: idx_ledger_transactions_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_correlation ON public.ledger_transactions USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_ledger_transactions_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_customer ON public.ledger_transactions USING btree (customer_id, created_at DESC);


--
-- Name: idx_ledger_transactions_loan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_loan ON public.ledger_transactions USING btree (loan_id);


--
-- Name: idx_ledger_transactions_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_payment ON public.ledger_transactions USING btree (payment_id);


--
-- Name: idx_ledger_transactions_platform_revenue_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_platform_revenue_event ON public.ledger_transactions USING btree (platform_revenue_event_id) WHERE (platform_revenue_event_id IS NOT NULL);


--
-- Name: idx_ledger_transactions_platform_revenue_settlement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_platform_revenue_settlement ON public.ledger_transactions USING btree (platform_revenue_settlement_id) WHERE (platform_revenue_settlement_id IS NOT NULL);


--
-- Name: idx_ledger_transactions_savings; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_savings ON public.ledger_transactions USING btree (savings_account_id);


--
-- Name: idx_ledger_transactions_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_source ON public.ledger_transactions USING btree (source_service, source_reference);


--
-- Name: idx_ledger_transactions_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_source_event ON public.ledger_transactions USING btree (source_service, source_event_type, source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: idx_ledger_transactions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_status ON public.ledger_transactions USING btree (tenant_id, status);


--
-- Name: idx_ledger_transactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_type ON public.ledger_transactions USING btree (tenant_id, transaction_type, created_at DESC);


--
-- Name: idx_ledger_transactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_transactions_user ON public.ledger_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_period_closures_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_period_closures_period ON public.period_closures USING btree (accounting_period_id);


--
-- Name: idx_posting_batch_items_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posting_batch_items_batch ON public.posting_batch_items USING btree (posting_batch_id);


--
-- Name: idx_posting_batch_items_journal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posting_batch_items_journal ON public.posting_batch_items USING btree (journal_id);


--
-- Name: idx_posting_batches_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posting_batches_source ON public.posting_batches USING btree (source_service, created_at DESC);


--
-- Name: idx_posting_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posting_batches_status ON public.posting_batches USING btree (tenant_id, status);


--
-- Name: idx_reconciliation_exceptions_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_exceptions_item ON public.reconciliation_exceptions USING btree (reconciliation_item_id);


--
-- Name: idx_reconciliation_exceptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_exceptions_status ON public.reconciliation_exceptions USING btree (tenant_id, status);


--
-- Name: idx_reconciliation_items_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_items_external ON public.reconciliation_items USING btree (external_reference);


--
-- Name: idx_reconciliation_items_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_items_run ON public.reconciliation_items USING btree (reconciliation_run_id);


--
-- Name: idx_reconciliation_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_items_status ON public.reconciliation_items USING btree (tenant_id, status);


--
-- Name: idx_reconciliation_runs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_runs_date ON public.reconciliation_runs USING btree (tenant_id, reconciliation_date DESC);


--
-- Name: idx_reconciliation_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reconciliation_runs_status ON public.reconciliation_runs USING btree (tenant_id, status);


--
-- Name: idx_settlement_batches_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_batches_date ON public.settlement_batches USING btree (tenant_id, settlement_date);


--
-- Name: idx_settlement_batches_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_batches_payment ON public.settlement_batches USING btree (payment_id) WHERE (payment_id IS NOT NULL);


--
-- Name: idx_settlement_batches_platform_revenue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_batches_platform_revenue ON public.settlement_batches USING btree (platform_revenue_settlement_id) WHERE (platform_revenue_settlement_id IS NOT NULL);


--
-- Name: idx_settlement_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_batches_status ON public.settlement_batches USING btree (tenant_id, status);


--
-- Name: idx_settlement_entries_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_entries_batch ON public.settlement_entries USING btree (settlement_batch_id);


--
-- Name: idx_settlement_entries_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_entries_external ON public.settlement_entries USING btree (external_reference);


--
-- Name: idx_settlement_entries_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_entries_transaction ON public.settlement_entries USING btree (transaction_id);


--
-- Name: idx_tax_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_entries_date ON public.ledger_tax_entries USING btree (tenant_id, tax_date);


--
-- Name: idx_tax_entries_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_entries_transaction ON public.ledger_tax_entries USING btree (transaction_id);


--
-- Name: idx_transaction_adjustments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_adjustments_status ON public.transaction_adjustments USING btree (tenant_id, status);


--
-- Name: idx_transaction_adjustments_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_adjustments_transaction ON public.transaction_adjustments USING btree (transaction_id);


--
-- Name: idx_transaction_entries_journal_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_entries_journal_entry ON public.ledger_transaction_entries USING btree (journal_entry_id);


--
-- Name: idx_transaction_entries_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_entries_transaction ON public.ledger_transaction_entries USING btree (transaction_id);


--
-- Name: idx_transaction_links_linked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_links_linked ON public.transaction_links USING btree (linked_transaction_id);


--
-- Name: idx_transaction_links_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_links_transaction ON public.transaction_links USING btree (transaction_id);


--
-- Name: idx_transaction_reversals_original; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transaction_reversals_original ON public.transaction_reversals USING btree (original_transaction_id);


--
-- Name: uq_ledger_platform_revenue_event_posting; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ledger_platform_revenue_event_posting ON public.ledger_transactions USING btree (book_id, platform_revenue_event_id, transaction_type) WHERE (platform_revenue_event_id IS NOT NULL);


--
-- Name: uq_ledger_platform_revenue_settlement_posting; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ledger_platform_revenue_settlement_posting ON public.ledger_transactions USING btree (book_id, platform_revenue_settlement_id, transaction_type) WHERE (platform_revenue_settlement_id IS NOT NULL);


--
-- Name: uq_ledger_primary_book_per_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ledger_primary_book_per_entity ON public.ledger_books USING btree (tenant_id, entity_id) WHERE ((is_primary = true) AND (deleted_at IS NULL));


--
-- Name: ledger_account_categories trg_account_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_categories_updated_at BEFORE UPDATE ON public.ledger_account_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account_holds trg_account_holds_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_holds_updated_at BEFORE UPDATE ON public.account_holds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_account_mappings trg_account_mappings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_mappings_updated_at BEFORE UPDATE ON public.ledger_account_mappings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customer_ledger_accounts trg_customer_ledger_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_customer_ledger_accounts_updated_at BEFORE UPDATE ON public.customer_ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: journals trg_journal_posting_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_journal_posting_guard BEFORE UPDATE ON public.journals FOR EACH ROW EXECUTE FUNCTION public.journal_posting_guard();


--
-- Name: journals trg_journals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_journals_updated_at BEFORE UPDATE ON public.journals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_accounts trg_ledger_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_accounts_updated_at BEFORE UPDATE ON public.ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_books trg_ledger_books_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_books_updated_at BEFORE UPDATE ON public.ledger_books FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_entities trg_ledger_entities_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_entities_updated_at BEFORE UPDATE ON public.ledger_entities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_fees trg_ledger_fees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_fees_updated_at BEFORE UPDATE ON public.ledger_fees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ledger_transactions trg_ledger_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_transactions_updated_at BEFORE UPDATE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: journal_entries trg_prevent_posted_entry_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_posted_entry_update BEFORE DELETE OR UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_entry_change();


--
-- Name: journals trg_prevent_posted_journal_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_posted_journal_delete BEFORE DELETE ON public.journals FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_delete();


--
-- Name: journals trg_prevent_posted_journal_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_posted_journal_update BEFORE UPDATE ON public.journals FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_update();


--
-- Name: reconciliation_exceptions trg_reconciliation_exceptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reconciliation_exceptions_updated_at BEFORE UPDATE ON public.reconciliation_exceptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: transaction_adjustments trg_transaction_adjustments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_transaction_adjustments_updated_at BEFORE UPDATE ON public.transaction_adjustments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: journals trg_validate_journal_book_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_journal_book_scope BEFORE INSERT OR UPDATE ON public.journals FOR EACH ROW EXECUTE FUNCTION public.validate_journal_book_scope();


--
-- Name: ledger_accounts trg_validate_ledger_account_book_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_ledger_account_book_scope BEFORE INSERT OR UPDATE ON public.ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_account_book_scope();


--
-- Name: ledger_books trg_validate_ledger_book_entity_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_ledger_book_entity_scope BEFORE INSERT OR UPDATE ON public.ledger_books FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_book_entity_scope();


--
-- Name: ledger_transactions trg_validate_ledger_transaction_book_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_ledger_transaction_book_scope BEFORE INSERT OR UPDATE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.validate_ledger_transaction_book_scope();


--
-- Name: ledger_account_categories fk_account_category_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_categories
    ADD CONSTRAINT fk_account_category_parent FOREIGN KEY (parent_category_id) REFERENCES public.ledger_account_categories(id) ON DELETE SET NULL;


--
-- Name: account_holds fk_account_hold_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_holds
    ADD CONSTRAINT fk_account_hold_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: ledger_account_limits fk_account_limits_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_limits
    ADD CONSTRAINT fk_account_limits_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE CASCADE;


--
-- Name: accounting_periods fk_accounting_period_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT fk_accounting_period_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: transaction_adjustments fk_adjustment_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_adjustments
    ADD CONSTRAINT fk_adjustment_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_account_balances fk_balance_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_balances
    ADD CONSTRAINT fk_balance_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE CASCADE;


--
-- Name: customer_balance_snapshots fk_balance_snapshot_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_balance_snapshots
    ADD CONSTRAINT fk_balance_snapshot_account FOREIGN KEY (ledger_account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: posting_batch_items fk_batch_item_batch; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batch_items
    ADD CONSTRAINT fk_batch_item_batch FOREIGN KEY (posting_batch_id) REFERENCES public.posting_batches(id) ON DELETE CASCADE;


--
-- Name: posting_batch_items fk_batch_item_journal; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batch_items
    ADD CONSTRAINT fk_batch_item_journal FOREIGN KEY (journal_id) REFERENCES public.journals(id) ON DELETE RESTRICT;


--
-- Name: ledger_control_accounts fk_control_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_control_accounts
    ADD CONSTRAINT fk_control_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE CASCADE;


--
-- Name: ledger_control_accounts fk_control_account_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_control_accounts
    ADD CONSTRAINT fk_control_account_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: customer_ledger_accounts fk_customer_ledger_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_ledger_accounts
    ADD CONSTRAINT fk_customer_ledger_account FOREIGN KEY (ledger_account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: account_hold_releases fk_hold_release_hold; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hold_releases
    ADD CONSTRAINT fk_hold_release_hold FOREIGN KEY (hold_id) REFERENCES public.account_holds(id) ON DELETE RESTRICT;


--
-- Name: ledger_interest_entries fk_interest_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_interest_entries
    ADD CONSTRAINT fk_interest_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: ledger_interest_entries fk_interest_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_interest_entries
    ADD CONSTRAINT fk_interest_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: journals fk_journal_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT fk_journal_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: journal_entries fk_journal_entry_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT fk_journal_entry_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: journal_entries fk_journal_entry_journal; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT fk_journal_entry_journal FOREIGN KEY (journal_id) REFERENCES public.journals(id) ON DELETE RESTRICT;


--
-- Name: journal_entry_metadata fk_journal_entry_metadata; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_metadata
    ADD CONSTRAINT fk_journal_entry_metadata FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;


--
-- Name: journals fk_journal_period; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT fk_journal_period FOREIGN KEY (accounting_period_id) REFERENCES public.accounting_periods(id) ON DELETE RESTRICT;


--
-- Name: journals fk_journal_reversal; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT fk_journal_reversal FOREIGN KEY (reversal_journal_id) REFERENCES public.journals(id) ON DELETE SET NULL;


--
-- Name: journals fk_journal_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT fk_journal_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_accounts fk_ledger_account_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT fk_ledger_account_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: ledger_accounts fk_ledger_account_category; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT fk_ledger_account_category FOREIGN KEY (category_id) REFERENCES public.ledger_account_categories(id) ON DELETE SET NULL;


--
-- Name: ledger_accounts fk_ledger_account_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT fk_ledger_account_parent FOREIGN KEY (parent_account_id) REFERENCES public.ledger_accounts(id) ON DELETE SET NULL;


--
-- Name: ledger_books fk_ledger_book_entity; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_books
    ADD CONSTRAINT fk_ledger_book_entity FOREIGN KEY (entity_id) REFERENCES public.ledger_entities(id) ON DELETE RESTRICT;


--
-- Name: ledger_fees fk_ledger_fee_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_fees
    ADD CONSTRAINT fk_ledger_fee_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE SET NULL;


--
-- Name: ledger_fees fk_ledger_fee_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_fees
    ADD CONSTRAINT fk_ledger_fee_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_inbox_events fk_ledger_inbox_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_inbox_events
    ADD CONSTRAINT fk_ledger_inbox_transaction FOREIGN KEY (ledger_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_transactions fk_ledger_transaction_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT fk_ledger_transaction_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: ledger_account_mappings fk_mapping_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_mappings
    ADD CONSTRAINT fk_mapping_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: ledger_account_mappings fk_mapping_credit_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_mappings
    ADD CONSTRAINT fk_mapping_credit_account FOREIGN KEY (credit_account_id) REFERENCES public.ledger_accounts(id);


--
-- Name: ledger_account_mappings fk_mapping_debit_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_account_mappings
    ADD CONSTRAINT fk_mapping_debit_account FOREIGN KEY (debit_account_id) REFERENCES public.ledger_accounts(id);


--
-- Name: ledger_transactions fk_parent_ledger_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT fk_parent_ledger_transaction FOREIGN KEY (parent_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: period_closures fk_period_closure_period; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_closures
    ADD CONSTRAINT fk_period_closure_period FOREIGN KEY (accounting_period_id) REFERENCES public.accounting_periods(id) ON DELETE RESTRICT;


--
-- Name: posting_batches fk_posting_batch_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posting_batches
    ADD CONSTRAINT fk_posting_batch_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: reconciliation_exceptions fk_reconciliation_exception_item; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_exceptions
    ADD CONSTRAINT fk_reconciliation_exception_item FOREIGN KEY (reconciliation_item_id) REFERENCES public.reconciliation_items(id) ON DELETE CASCADE;


--
-- Name: reconciliation_items fk_reconciliation_item_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_items
    ADD CONSTRAINT fk_reconciliation_item_run FOREIGN KEY (reconciliation_run_id) REFERENCES public.reconciliation_runs(id) ON DELETE CASCADE;


--
-- Name: reconciliation_items fk_reconciliation_item_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_items
    ADD CONSTRAINT fk_reconciliation_item_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: transaction_reversals fk_reversal_original; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_reversals
    ADD CONSTRAINT fk_reversal_original FOREIGN KEY (original_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;


--
-- Name: transaction_reversals fk_reversal_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_reversals
    ADD CONSTRAINT fk_reversal_transaction FOREIGN KEY (reversal_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;


--
-- Name: settlement_batches fk_settlement_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_batches
    ADD CONSTRAINT fk_settlement_account FOREIGN KEY (settlement_account_id) REFERENCES public.ledger_accounts(id) ON DELETE SET NULL;


--
-- Name: settlement_entries fk_settlement_entry_batch; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT fk_settlement_entry_batch FOREIGN KEY (settlement_batch_id) REFERENCES public.settlement_batches(id) ON DELETE CASCADE;


--
-- Name: settlement_entries fk_settlement_entry_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT fk_settlement_entry_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_tax_entries fk_tax_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tax_entries
    ADD CONSTRAINT fk_tax_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: ledger_tax_entries fk_tax_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tax_entries
    ADD CONSTRAINT fk_tax_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE SET NULL;


--
-- Name: ledger_tenant_accounts fk_tenant_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tenant_accounts
    ADD CONSTRAINT fk_tenant_account FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE CASCADE;


--
-- Name: ledger_tenant_accounts fk_tenant_account_book; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_tenant_accounts
    ADD CONSTRAINT fk_tenant_account_book FOREIGN KEY (book_id) REFERENCES public.ledger_books(id) ON DELETE RESTRICT;


--
-- Name: ledger_transaction_entries fk_transaction_entry_journal_entry; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transaction_entries
    ADD CONSTRAINT fk_transaction_entry_journal_entry FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE RESTRICT;


--
-- Name: ledger_transaction_entries fk_transaction_entry_transaction; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transaction_entries
    ADD CONSTRAINT fk_transaction_entry_transaction FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;


--
-- Name: transaction_links fk_transaction_link_source; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_links
    ADD CONSTRAINT fk_transaction_link_source FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE CASCADE;


--
-- Name: transaction_links fk_transaction_link_target; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_links
    ADD CONSTRAINT fk_transaction_link_target FOREIGN KEY (linked_transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE CASCADE;


--
-- Name: account_hold_releases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_hold_releases ENABLE ROW LEVEL SECURITY;

--
-- Name: account_hold_releases account_hold_releases_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_hold_releases_policy ON public.account_hold_releases USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: account_holds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_holds ENABLE ROW LEVEL SECURITY;

--
-- Name: account_holds account_holds_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_holds_policy ON public.account_holds USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: accounting_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: accounting_periods accounting_periods_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounting_periods_policy ON public.accounting_periods USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: customer_balance_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_balance_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_balance_snapshots customer_balance_snapshots_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customer_balance_snapshots_policy ON public.customer_balance_snapshots USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: customer_ledger_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_ledger_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_ledger_accounts customer_ledger_accounts_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY customer_ledger_accounts_policy ON public.customer_ledger_accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_entries journal_entries_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_entries_policy ON public.journal_entries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: journal_entry_metadata; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_entry_metadata ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_entry_metadata journal_entry_metadata_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_entry_metadata_policy ON public.journal_entry_metadata USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: journals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;

--
-- Name: journals journals_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journals_policy ON public.journals USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_account_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_account_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_account_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_account_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_account_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_account_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_account_limits ledger_account_limits_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_account_limits_policy ON public.ledger_account_limits USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_account_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_account_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_accounts ledger_accounts_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_accounts_tenant_policy ON public.ledger_accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_audit_logs ledger_audit_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_audit_policy ON public.ledger_audit_logs USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_account_balances ledger_balances_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_balances_policy ON public.ledger_account_balances USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_books; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_books ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_books ledger_books_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_books_tenant_policy ON public.ledger_books USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_account_categories ledger_categories_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_categories_tenant_policy ON public.ledger_account_categories USING (((tenant_id IS NULL) OR (tenant_id = public.current_tenant_id()))) WITH CHECK (((tenant_id IS NULL) OR (tenant_id = public.current_tenant_id())));


--
-- Name: ledger_control_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_control_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_control_accounts ledger_control_accounts_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_control_accounts_policy ON public.ledger_control_accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_entities ledger_entities_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_entities_tenant_policy ON public.ledger_entities USING (((tenant_id = public.current_tenant_id()) OR (is_platform = true))) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_fees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_fees ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_fees ledger_fees_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_fees_policy ON public.ledger_fees USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_inbox_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_inbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_inbox_events ledger_inbox_events_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_inbox_events_policy ON public.ledger_inbox_events USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_integrity_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_integrity_checks ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_integrity_checks ledger_integrity_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_integrity_policy ON public.ledger_integrity_checks USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_interest_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_interest_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_interest_entries ledger_interest_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_interest_policy ON public.ledger_interest_entries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_account_mappings ledger_mappings_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_mappings_tenant_policy ON public.ledger_account_mappings USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_outbox_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_outbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_outbox_events ledger_outbox_events_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_outbox_events_policy ON public.ledger_outbox_events USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_snapshots ledger_snapshots_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_snapshots_policy ON public.ledger_snapshots USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_tax_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_tax_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_tax_entries ledger_tax_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_tax_policy ON public.ledger_tax_entries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_tenant_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_tenant_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_tenant_accounts ledger_tenant_accounts_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_tenant_accounts_policy ON public.ledger_tenant_accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_transaction_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_transaction_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_transaction_entries ledger_transaction_entries_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_transaction_entries_policy ON public.ledger_transaction_entries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: ledger_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_transactions ledger_transactions_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_transactions_policy ON public.ledger_transactions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: period_closures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.period_closures ENABLE ROW LEVEL SECURITY;

--
-- Name: period_closures period_closures_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY period_closures_policy ON public.period_closures USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: posting_batch_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posting_batch_items ENABLE ROW LEVEL SECURITY;

--
-- Name: posting_batch_items posting_batch_items_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posting_batch_items_policy ON public.posting_batch_items USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: posting_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posting_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: posting_batches posting_batches_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posting_batches_policy ON public.posting_batches USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: reconciliation_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_exceptions reconciliation_exceptions_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reconciliation_exceptions_policy ON public.reconciliation_exceptions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: reconciliation_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_items ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_items reconciliation_items_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reconciliation_items_policy ON public.reconciliation_items USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: reconciliation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_runs reconciliation_runs_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reconciliation_runs_policy ON public.reconciliation_runs USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: settlement_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_batches settlement_batches_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlement_batches_policy ON public.settlement_batches USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: settlement_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_entries settlement_entries_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlement_entries_policy ON public.settlement_entries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: transaction_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transaction_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: transaction_adjustments transaction_adjustments_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_adjustments_policy ON public.transaction_adjustments USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: transaction_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transaction_links ENABLE ROW LEVEL SECURITY;

--
-- Name: transaction_links transaction_links_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_links_policy ON public.transaction_links USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- Name: transaction_reversals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transaction_reversals ENABLE ROW LEVEL SECURITY;

--
-- Name: transaction_reversals transaction_reversals_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_reversals_policy ON public.transaction_reversals USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));


--
-- PostgreSQL database dump complete
--

