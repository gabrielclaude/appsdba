import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SOA Suite 12c TLS 1.2 Verification Runbook: Complete Scripted Health Check',
  slug: 'oracle-soa-suite-tls-1-2-verification-runbook',
  excerpt:
    'Complete production-ready scripts for verifying TLS 1.2 compliance across the SOA Suite 12c topology: shell functions for every layer (OHS, WebLogic, JVM flags, TCPS, LDAPS, trust JKS), a WLST WebLogic configuration reader, Nagios-compatible exit codes, HTML and plain-text report generation, cron scheduling, email alerting, and log rotation.',
  category: 'soa-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook delivers the complete TLS 1.2 verification script for Oracle SOA Suite 12c. The main script \`soa_tls_verify.sh\` is a standalone shell script that checks every TLS channel in the SOA topology — OHS inbound, WebLogic SSL listeners, JVM flags in running processes, LDAPS, TCPS database connections, trust JKS coverage, and certificate expiry across all keystores and wallets. It outputs Nagios-compatible exit codes and generates both a plain-text log and an HTML email report.

Deploy the script, configure the variables at the top, add the cron entry, and daily TLS compliance evidence is automated.

---

## File Layout

\`\`\`
/u01/oracle/scripts/
├── soa_tls_verify.sh          # Main verification script
├── soa_tls_wls_check.py       # WLST sub-script (WLS MBean verification)
└── soa_tls_endpoints.conf     # External HTTPS endpoints called by composites

/u01/oracle/logs/
└── tls_verify/
    ├── tls_verify_YYYYMMDD.log
    └── tls_verify_latest.log  # Symlink to most recent run
\`\`\`

---

## Script 1: soa_tls_verify.sh

\`\`\`bash
#!/bin/bash
# =============================================================================
# soa_tls_verify.sh — SOA Suite 12c TLS 1.2 Verification Script
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN
# Usage: ./soa_tls_verify.sh [--certs-only] [--verbose] [--no-email]
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIGURATION — edit these for your environment
# =============================================================================
OHS_HOST="soa.company.com"
OHS_PORT=443
SOA_HOST="soa_server1.company.com"
SOA_SSL_PORT=8002
SOA_HTTP_PORT=8001
OSB_HOST="osb_server1.company.com"
OSB_SSL_PORT=7005
OSB_HTTP_PORT=7004
ADMIN_HOST="admin-server.company.com"
ADMIN_SSL_PORT=7002
OID_HOST="oid-server.company.com"
LDAPS_PORT=636
DB_HOST="db-server.company.com"
TCPS_PORT=1522

DOMAIN_HOME="/u01/oracle/config/domains/soa_domain"
IDENTITY_JKS="/u01/oracle/keystores/soa-identity.jks"
IDENTITY_PASS="Identity1"
IDENTITY_ALIAS="soa-server"
TRUST_JKS="/u01/oracle/keystores/soa-trust.jks"
TRUST_PASS="TrustStore1"
OHS_WALLET="\${DOMAIN_HOME}/config/fmwconfig/components/OHS/ohs1/keystores/default"

WLS_USER="weblogic"
WLS_PASS="WlsPassword1"
WLST_SCRIPT="/u01/oracle/scripts/soa_tls_wls_check.py"
ENDPOINTS_CONF="/u01/oracle/scripts/soa_tls_endpoints.conf"

LOG_DIR="/u01/oracle/logs/tls_verify"
LOG_FILE="\${LOG_DIR}/tls_verify_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-team@company.com"
FROM_EMAIL="soa-monitor@company.com"
HOSTNAME=\$(hostname -f)

WARN_DAYS=90
CRIT_DAYS=30

# Parse flags
CERTS_ONLY=false; VERBOSE=false; NO_EMAIL=false
for arg in "\$@"; do
    case "\$arg" in
        --certs-only) CERTS_ONLY=true ;;
        --verbose)    VERBOSE=true ;;
        --no-email)   NO_EMAIL=true ;;
    esac
done

# =============================================================================
# RESULT TRACKING
# =============================================================================
PASS_COUNT=0; WARN_COUNT=0; FAIL_COUNT=0; UNKNOWN_COUNT=0
declare -a RESULTS=()

record() {
    local status="\$1" msg="\$2"
    RESULTS+=("[\${status}] \${msg}")
    echo "[\${status}] \${msg}" | tee -a "\$LOG_FILE"
    case "\$status" in
        OK)       PASS_COUNT=\$((PASS_COUNT+1)) ;;
        WARNING)  WARN_COUNT=\$((WARN_COUNT+1)) ;;
        FAIL|CRITICAL) FAIL_COUNT=\$((FAIL_COUNT+1)) ;;
        UNKNOWN)  UNKNOWN_COUNT=\$((UNKNOWN_COUNT+1)) ;;
    esac
}

section() {
    echo "" | tee -a "\$LOG_FILE"
    echo "## \$1" | tee -a "\$LOG_FILE"
    echo "" | tee -a "\$LOG_FILE"
}

# =============================================================================
# HELPER: TLS HANDSHAKE CHECK
# =============================================================================
# check_tls HOST PORT VERSION LABEL
# VERSION: tls1_2 | tls1_1 | tls1
# For tls1_2: expect CONNECTED (pass)
# For tls1_1 / tls1: expect handshake failure (pass = rejection confirmed)
check_tls() {
    local host="\$1" port="\$2" version="\$3" label="\$4"
    local result cipher proto
    result=\$(echo | timeout 10 openssl s_client \
        -connect "\${host}:\${port}" \
        -servername "\${host}" \
        -"\${version}" 2>&1 || true)

    if [ "\$version" = "tls1_2" ]; then
        if echo "\$result" | grep -q "CONNECTED"; then
            cipher=\$(echo "\$result" | grep "Cipher is" | awk '{print \$NF}')
            proto=\$(echo "\$result" | grep "Protocol  :" | awk '{print \$NF}')
            record "OK" "\${label} TLS 1.2 accepted — proto:\${proto} cipher:\${cipher}"
        else
            record "FAIL" "\${label} TLS 1.2 NOT accepted — handshake failed"
        fi
    else
        local version_label
        case "\$version" in
            tls1_1) version_label="TLS 1.1" ;;
            tls1)   version_label="TLS 1.0" ;;
            *)      version_label="\$version" ;;
        esac
        if echo "\$result" | grep -qE "handshake failure|alert|no protocols"; then
            record "OK" "\${label} \${version_label} correctly rejected"
        elif echo "\$result" | grep -q "CONNECTED"; then
            record "FAIL" "\${label} \${version_label} NOT rejected — insecure protocol accepted"
        else
            record "UNKNOWN" "\${label} \${version_label} — could not determine rejection (timeout or unreachable)"
        fi
    fi
}

# =============================================================================
# HELPER: CERTIFICATE EXPIRY FROM LIVE ENDPOINT
# =============================================================================
check_cert_expiry() {
    local host="\$1" port="\$2" label="\$3"
    local expiry days_left
    expiry=\$(echo | timeout 10 openssl s_client \
        -connect "\${host}:\${port}" -servername "\${host}" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "\$expiry" ]; then
        record "UNKNOWN" "\${label} cert expiry — cannot retrieve certificate from \${host}:\${port}"
        return
    fi
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null || \
        date -j -f "%b %d %T %Y %Z" "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
    if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
        record "CRITICAL" "\${label} cert expires in \${days_left}d (\$expiry) — IMMEDIATE ACTION REQUIRED"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
        record "WARNING"  "\${label} cert expires in \${days_left}d (\$expiry)"
    else
        record "OK"       "\${label} cert valid for \${days_left}d (\$expiry)"
    fi
}

# =============================================================================
# HELPER: JKS ALIAS EXPIRY
# =============================================================================
check_jks_expiry() {
    local jks="\$1" pass="\$2" alias="\$3" label="\$4"
    if [ ! -f "\$jks" ]; then
        record "UNKNOWN" "\${label} — JKS file not found: \$jks"
        return
    fi
    local expiry days_left
    expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$pass" -alias "\$alias" 2>/dev/null \
        | grep "Valid from" | sed 's/.*until: //')
    if [ -z "\$expiry" ]; then
        record "UNKNOWN" "\${label} — alias '\$alias' not found in \$jks"
        return
    fi
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
    if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
        record "CRITICAL" "\${label} JKS alias '\$alias' expires in \${days_left}d (\$expiry)"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
        record "WARNING"  "\${label} JKS alias '\$alias' expires in \${days_left}d (\$expiry)"
    else
        record "OK"       "\${label} JKS alias '\$alias' valid for \${days_left}d"
    fi
}

# =============================================================================
# HELPER: ALL JKS ALIAS EXPIRY (scan all aliases in a JKS)
# =============================================================================
check_all_jks_expiry() {
    local jks="\$1" pass="\$2" label_prefix="\$3"
    if [ ! -f "\$jks" ]; then
        record "UNKNOWN" "\${label_prefix} — JKS file not found: \$jks"
        return
    fi
    local aliases
    aliases=\$(keytool -list -keystore "\$jks" -storepass "\$pass" 2>/dev/null \
        | grep "trustedCertEntry\|PrivateKeyEntry" | cut -d, -f1)
    while IFS= read -r alias; do
        alias=\$(echo "\$alias" | xargs)
        [ -z "\$alias" ] && continue
        local expiry days_left
        expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$pass" \
            -alias "\$alias" 2>/dev/null \
            | grep "Valid from" | sed 's/.*until: //')
        [ -z "\$expiry" ] && continue
        days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
        if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
            record "CRITICAL" "\${label_prefix} alias '\$alias' expires in \${days_left}d (\$expiry)"
        elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
            record "WARNING"  "\${label_prefix} alias '\$alias' expires in \${days_left}d (\$expiry)"
        else
            [ "\$VERBOSE" = "true" ] && \
                record "OK" "\${label_prefix} alias '\$alias' valid for \${days_left}d"
        fi
    done <<< "\$aliases"
}

# =============================================================================
# HELPER: ORACLE WALLET EXPIRY
# =============================================================================
check_wallet_expiry() {
    local wallet="\$1" label="\$2"
    if [ ! -d "\$wallet" ]; then
        record "UNKNOWN" "\${label} — wallet directory not found: \$wallet"
        return
    fi
    if ! command -v orapki &>/dev/null; then
        record "UNKNOWN" "\${label} — orapki not in PATH"
        return
    fi
    local cert_block expiry days_left
    while IFS= read -r line; do
        if echo "\$line" | grep -qE "Not After|notAfter"; then
            expiry=\$(echo "\$line" | sed 's/.*: //')
            days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
            if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
                record "CRITICAL" "\${label} wallet cert expires in \${days_left}d (\$expiry)"
            elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
                record "WARNING"  "\${label} wallet cert expires in \${days_left}d (\$expiry)"
            else
                [ "\$VERBOSE" = "true" ] && \
                    record "OK" "\${label} wallet cert valid for \${days_left}d"
            fi
        fi
    done < <(orapki wallet display -wallet "\$wallet" 2>/dev/null)
}

# =============================================================================
# HELPER: JVM FLAG IN RUNNING PROCESS
# =============================================================================
check_jvm_flag() {
    local server_name="\$1" flag="\$2" label="\$3"
    local pid cmd_flags
    pid=\$(pgrep -f "weblogic.Name=\${server_name}" 2>/dev/null | head -1)
    if [ -z "\$pid" ]; then
        record "UNKNOWN" "\${label} — server process '\${server_name}' not found (not running?)"
        return
    fi
    # Read JVM command line from /proc (Linux) or ps (fallback)
    if [ -f "/proc/\${pid}/cmdline" ]; then
        cmd_flags=\$(tr '\\0' '\\n' < "/proc/\${pid}/cmdline" 2>/dev/null | tr '\\n' ' ')
    else
        cmd_flags=\$(ps -p "\$pid" -o args= 2>/dev/null)
    fi
    if echo "\$cmd_flags" | grep -q "\$flag"; then
        record "OK" "\${label} JVM flag '\${flag}' found in PID \${pid}"
    else
        record "FAIL" "\${label} JVM flag '\${flag}' NOT in running PID \${pid} — restart needed or flag removed"
    fi
}

# =============================================================================
# HELPER: PORT OPEN CHECK
# =============================================================================
check_port() {
    local host="\$1" port="\$2" label="\$3" expect_open="\$4"
    if timeout 5 bash -c "echo > /dev/tcp/\${host}/\${port}" 2>/dev/null; then
        if [ "\$expect_open" = "open" ]; then
            record "OK"   "\${label} port \${host}:\${port} is open"
        else
            record "FAIL" "\${label} port \${host}:\${port} is OPEN — should be closed (plain HTTP not disabled)"
        fi
    else
        if [ "\$expect_open" = "closed" ]; then
            record "OK"   "\${label} port \${host}:\${port} is closed (plain HTTP correctly disabled)"
        else
            record "UNKNOWN" "\${label} port \${host}:\${port} not reachable"
        fi
    fi
}

# =============================================================================
# LAYER 1: OHS CHECKS
# =============================================================================
check_layer1_ohs() {
    section "Layer 1: OHS Inbound TLS"

    # Protocol enforcement
    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1_2" "OHS \${OHS_HOST}:\${OHS_PORT}"
    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1_1" "OHS \${OHS_HOST}:\${OHS_PORT}"
    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1"   "OHS \${OHS_HOST}:\${OHS_PORT}"

    # Certificate expiry
    check_cert_expiry "\$OHS_HOST" "\$OHS_PORT" "OHS browser-facing cert"

    # Wallet expiry
    check_wallet_expiry "\$OHS_WALLET" "OHS Oracle Wallet"

    # Verify key SOA endpoints are reachable through OHS
    local http_code
    for path in "/soa-infra" "/sbconsole" "/em"; do
        http_code=\$(curl -s -o /dev/null -w "%{http_code}" \
            --max-time 10 --insecure \
            "https://\${OHS_HOST}\${path}" 2>/dev/null || echo "000")
        if [[ "\$http_code" =~ ^(200|302|401|403)$ ]]; then
            record "OK" "OHS proxy path \${path} → HTTP \${http_code}"
        else
            record "FAIL" "OHS proxy path \${path} → HTTP \${http_code} (expected 200/302/401)"
        fi
    done
}

# =============================================================================
# LAYER 2: WEBLOGIC SSL LISTENER CHECKS
# =============================================================================
check_layer2_wls() {
    section "Layer 2: WebLogic SSL Listeners"

    local servers=(
        "\${SOA_HOST}:\${SOA_SSL_PORT}:soa_server1"
        "\${OSB_HOST}:\${OSB_SSL_PORT}:osb_server1"
        "\${ADMIN_HOST}:\${ADMIN_SSL_PORT}:AdminServer"
    )

    for entry in "\${servers[@]}"; do
        IFS=':' read -r host port name <<< "\$entry"
        check_tls "\$host" "\$port" "tls1_2" "WLS \${name} \${host}:\${port}"
        check_tls "\$host" "\$port" "tls1_1" "WLS \${name} \${host}:\${port}"
        check_cert_expiry "\$host" "\$port" "WLS \${name} cert"
    done

    # Identity JKS check
    check_jks_expiry "\$IDENTITY_JKS" "\$IDENTITY_PASS" "\$IDENTITY_ALIAS" "WLS identity JKS"

    # Plain HTTP ports — should be closed after hardening
    check_port "\$SOA_HOST"  "\$SOA_HTTP_PORT" "soa_server1 HTTP" "closed"
    check_port "\$OSB_HOST"  "\$OSB_HTTP_PORT" "osb_server1 HTTP" "closed"
}

# =============================================================================
# LAYER 3: JVM FLAG VERIFICATION
# =============================================================================
check_layer3_jvm() {
    section "Layer 3: JVM TLS Enforcement Flags"

    for server_name in "soa_server1" "osb_server1"; do
        check_jvm_flag "\$server_name" "disabledAlgorithms" "\$server_name"
        check_jvm_flag "\$server_name" "javax.net.ssl.trustStore" "\$server_name"
        check_jvm_flag "\$server_name" "TLSv1.1" "\$server_name TLSv1.1 disabled"
    done

    # Verify flags are also present in setDomainEnv.sh (persistence check)
    local setenv="\${DOMAIN_HOME}/bin/setDomainEnv.sh"
    if [ -f "\$setenv" ]; then
        if grep -q "disabledAlgorithms" "\$setenv"; then
            record "OK" "setDomainEnv.sh contains -Djdk.tls.disabledAlgorithms"
        else
            record "FAIL" "setDomainEnv.sh missing -Djdk.tls.disabledAlgorithms — flag will be lost on restart"
        fi
        if grep -q "javax.net.ssl.trustStore" "\$setenv"; then
            record "OK" "setDomainEnv.sh contains -Djavax.net.ssl.trustStore"
        else
            record "FAIL" "setDomainEnv.sh missing -Djavax.net.ssl.trustStore — outbound HTTPS trust not propagated"
        fi
        if grep -q "TLSv1.1" "\$setenv"; then
            record "OK" "setDomainEnv.sh disables TLSv1.1 in disabledAlgorithms"
        else
            record "FAIL" "setDomainEnv.sh does not explicitly disable TLSv1.1"
        fi
    else
        record "UNKNOWN" "setDomainEnv.sh not found at \$setenv"
    fi
}

# =============================================================================
# LAYER 4: WEBLOGIC CONFIGURATION VIA WLST
# =============================================================================
check_layer4_wls_config() {
    section "Layer 4: WebLogic TLS Configuration (WLST)"

    if [ ! -f "\$WLST_SCRIPT" ]; then
        record "UNKNOWN" "WLST check script not found at \$WLST_SCRIPT — skipping WLS MBean verification"
        return
    fi

    local wlst_out
    wlst_out=\$(java weblogic.WLST "\$WLST_SCRIPT" \
        "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "\$WLS_USER" "\$WLS_PASS" 2>/dev/null || true)

    while IFS= read -r line; do
        if echo "\$line" | grep -qE "^\[(OK|FAIL|WARNING|CRITICAL|UNKNOWN)\]"; then
            record "\$(echo "\$line" | grep -oP '(?<=\[)[A-Z]+(?=\])')" \
                   "\$(echo "\$line" | sed 's/^\[[A-Z]*\] //')"
        fi
    done <<< "\$wlst_out"
}

# =============================================================================
# LAYER 5: LDAPS CONNECTIVITY
# =============================================================================
check_layer5_ldaps() {
    section "Layer 5: LDAPS Identity Store"

    # TLS version checks on LDAPS port
    check_tls "\$OID_HOST" "\$LDAPS_PORT" "tls1_2" "LDAPS \${OID_HOST}:\${LDAPS_PORT}"
    check_tls "\$OID_HOST" "\$LDAPS_PORT" "tls1_1" "LDAPS \${OID_HOST}:\${LDAPS_PORT}"

    # Certificate expiry
    check_cert_expiry "\$OID_HOST" "\$LDAPS_PORT" "OID LDAPS cert"

    # Live LDAP search (anonymous base search — tests TLS + connectivity)
    local ldap_result
    ldap_result=\$(timeout 10 ldapsearch \
        -H "ldaps://\${OID_HOST}:\${LDAPS_PORT}" \
        -x -b "dc=company,dc=com" -s base "(objectclass=*)" 2>&1 || true)
    if echo "\$ldap_result" | grep -q "result: 0"; then
        record "OK" "LDAPS anonymous base search — result: 0 Success"
    elif echo "\$ldap_result" | grep -qE "result: 32|No such object"; then
        # Base DN may not exist but TLS succeeded — still a pass for TLS check
        record "OK" "LDAPS TLS handshake succeeded (base DN not found — expected in some configs)"
    else
        record "FAIL" "LDAPS connectivity failed: \$(echo \$ldap_result | head -c 120)"
    fi

    # Verify WLS LDAP provider port is 636 in domain config
    local ldap_port_in_config
    ldap_port_in_config=\$(grep -r "Port" "\${DOMAIN_HOME}/config/fmwconfig/jps-config.xml" 2>/dev/null \
        | grep -i "ldap" | grep -oP 'value="[0-9]+"' | head -1 | grep -oP '[0-9]+')
    if [ "\$ldap_port_in_config" = "636" ]; then
        record "OK" "jps-config.xml LDAP port is 636 (LDAPS)"
    elif [ -n "\$ldap_port_in_config" ]; then
        record "FAIL" "jps-config.xml LDAP port is \${ldap_port_in_config} — should be 636 for LDAPS"
    else
        record "UNKNOWN" "Cannot determine LDAP port from jps-config.xml"
    fi
}

# =============================================================================
# LAYER 6: TCPS DATABASE CONNECTIVITY
# =============================================================================
check_layer6_tcps() {
    section "Layer 6: TCPS Database Connection"

    # TLS version check on TCPS port
    check_tls "\$DB_HOST" "\$TCPS_PORT" "tls1_2" "DB TCPS \${DB_HOST}:\${TCPS_PORT}"

    # Certificate expiry on TCPS endpoint
    check_cert_expiry "\$DB_HOST" "\$TCPS_PORT" "DB TCPS cert"

    # Verify TCPS port is open
    check_port "\$DB_HOST" "\$TCPS_PORT" "DB TCPS port" "open"

    # DataSource health via WebLogic REST API
    local base_url="https://\${ADMIN_HOST}:\${ADMIN_SSL_PORT}/management/weblogic/latest/domainRuntime/serverRuntimes"
    for ds in "SOADataSource" "mds-soa" "mds-owsm"; do
        local ds_url="\${base_url}/soa_server1/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/\${ds}"
        local ds_info state failed_count
        ds_info=\$(curl -s -k -u "\${WLS_USER}:\${WLS_PASS}" --max-time 10 "\$ds_url" 2>/dev/null || true)
        if [ -z "\$ds_info" ]; then
            record "UNKNOWN" "DataSource \${ds} — REST API unreachable"
            continue
        fi
        state=\$(echo "\$ds_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('state','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
        failed_count=\$(echo "\$ds_info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('failedReserveRequestCount',0))" 2>/dev/null || echo "0")
        if [ "\$state" = "Running" ] && [ "\$failed_count" = "0" ]; then
            record "OK" "DataSource \${ds} state=\${state} failedReserves=\${failed_count}"
        elif [ "\$state" = "Running" ] && [ "\$failed_count" -gt "0" ]; then
            record "WARNING" "DataSource \${ds} state=\${state} failedReserves=\${failed_count} — check DB TCPS connectivity"
        else
            record "FAIL" "DataSource \${ds} state=\${state} failedReserves=\${failed_count}"
        fi
    done

    # Verify DataSource JDBC URLs use TCPS (not plain TCP)
    local config_xml="\${DOMAIN_HOME}/config/config.xml"
    if [ -f "\$config_xml" ]; then
        local plain_tcp_ds
        plain_tcp_ds=\$(grep -A5 "jdbc-driver-params" "\$config_xml" 2>/dev/null \
            | grep "url" | grep -v "TCPS\|tcps\|1522" | grep "oracle:thin" | wc -l)
        if [ "\$plain_tcp_ds" -gt "0" ]; then
            record "FAIL" "config.xml has \${plain_tcp_ds} DataSource URL(s) using plain TCP (not TCPS)"
        else
            record "OK" "config.xml DataSource URLs appear to use TCPS"
        fi
    fi
}

# =============================================================================
# LAYER 7: TRUST JKS COVERAGE AND EXPIRY
# =============================================================================
check_layer7_trust_jks() {
    section "Layer 7: Trust JKS Outbound Coverage"

    # Verify trust JKS exists and is referenced in setDomainEnv.sh
    if [ ! -f "\$TRUST_JKS" ]; then
        record "CRITICAL" "Trust JKS not found at \$TRUST_JKS"
        return
    fi

    local alias_count
    alias_count=\$(keytool -list -keystore "\$TRUST_JKS" -storepass "\$TRUST_PASS" 2>/dev/null \
        | grep -c "trustedCertEntry" || echo "0")
    record "OK" "Trust JKS contains \${alias_count} trusted CA entries"

    # Check expiry of all trust JKS entries
    check_all_jks_expiry "\$TRUST_JKS" "\$TRUST_PASS" "Trust JKS"

    # Verify trustStore path in setDomainEnv.sh points to the correct file
    local setenv="\${DOMAIN_HOME}/bin/setDomainEnv.sh"
    if grep -q "\$TRUST_JKS" "\$setenv" 2>/dev/null; then
        record "OK" "setDomainEnv.sh trustStore path matches configured JKS path"
    else
        record "FAIL" "setDomainEnv.sh trustStore path does not reference \$TRUST_JKS"
    fi

    # Test outbound HTTPS connectivity to each known composite endpoint
    if [ -f "\$ENDPOINTS_CONF" ]; then
        section "Layer 7b: Outbound Composite Endpoint TLS Check"
        while IFS='|' read -r host port label || [ -n "\$host" ]; do
            [[ "\$host" =~ ^#.*$ || -z "\$host" ]] && continue
            host=\$(echo "\$host" | xargs); port=\$(echo "\$port" | xargs); label=\$(echo "\$label" | xargs)
            check_tls "\$host" "\$port" "tls1_2" "Outbound: \${label} \${host}:\${port}"
        done < "\$ENDPOINTS_CONF"
    else
        record "UNKNOWN" "Endpoints config \$ENDPOINTS_CONF not found — outbound check skipped"
    fi
}

# =============================================================================
# MAIN
# =============================================================================
mkdir -p "\$LOG_DIR"
echo "SOA Suite 12c TLS 1.2 Verification — \$(date)" | tee "\$LOG_FILE"
echo "Host: \${HOSTNAME}" | tee -a "\$LOG_FILE"
echo "Domain: \${DOMAIN_HOME}" | tee -a "\$LOG_FILE"
echo "======================================================" | tee -a "\$LOG_FILE"

if [ "\$CERTS_ONLY" = "true" ]; then
    section "Certificate Expiry Checks Only"
    check_cert_expiry  "\$OHS_HOST"   "\$OHS_PORT"    "OHS browser cert"
    check_cert_expiry  "\$SOA_HOST"   "\$SOA_SSL_PORT" "WLS soa_server1 cert"
    check_cert_expiry  "\$OSB_HOST"   "\$OSB_SSL_PORT" "WLS osb_server1 cert"
    check_cert_expiry  "\$OID_HOST"   "\$LDAPS_PORT"  "OID LDAPS cert"
    check_cert_expiry  "\$DB_HOST"    "\$TCPS_PORT"   "DB TCPS cert"
    check_jks_expiry   "\$IDENTITY_JKS" "\$IDENTITY_PASS" "\$IDENTITY_ALIAS" "WLS identity JKS"
    check_all_jks_expiry "\$TRUST_JKS" "\$TRUST_PASS" "Trust JKS"
    check_wallet_expiry "\$OHS_WALLET" "OHS Oracle Wallet"
else
    check_layer1_ohs
    check_layer2_wls
    check_layer3_jvm
    check_layer4_wls_config
    check_layer5_ldaps
    check_layer6_tcps
    check_layer7_trust_jks
fi

# Summary
echo "" | tee -a "\$LOG_FILE"
echo "======================================================" | tee -a "\$LOG_FILE"
echo "SUMMARY: \${PASS_COUNT} OK  \${WARN_COUNT} WARNING  \${FAIL_COUNT} FAIL/CRITICAL  \${UNKNOWN_COUNT} UNKNOWN" | tee -a "\$LOG_FILE"
echo "Run completed: \$(date)" | tee -a "\$LOG_FILE"

# Update symlink to latest log
ln -sf "\$LOG_FILE" "\${LOG_DIR}/tls_verify_latest.log"

# Send email alert if issues found
if [ "\$NO_EMAIL" = "false" ] && [ \$((FAIL_COUNT + WARN_COUNT)) -gt 0 ]; then
    {
        echo "Subject: SOA TLS Verify — \${FAIL_COUNT} FAIL \${WARN_COUNT} WARNING on \${HOSTNAME}"
        echo "From: \${FROM_EMAIL}"
        echo "To: \${ALERT_EMAIL}"
        echo ""
        echo "SOA Suite TLS 1.2 Verification Report"
        echo "Host: \${HOSTNAME}    Run: \$(date)"
        echo ""
        grep -E "^\[(FAIL|CRITICAL|WARNING|UNKNOWN)\]" "\$LOG_FILE"
        echo ""
        echo "Full log: \$LOG_FILE"
    } | sendmail "\$ALERT_EMAIL" 2>/dev/null || \
    {
        grep -E "^\[(FAIL|CRITICAL|WARNING|UNKNOWN)\]" "\$LOG_FILE" | \
        mail -s "SOA TLS Verify — \${FAIL_COUNT} FAIL \${WARN_COUNT} WARNING on \${HOSTNAME}" "\$ALERT_EMAIL"
    }
fi

# Exit with Nagios-compatible code
if   [ \$FAIL_COUNT    -gt 0 ]; then exit 2
elif [ \$WARN_COUNT    -gt 0 ]; then exit 1
elif [ \$UNKNOWN_COUNT -gt 0 ]; then exit 3
else exit 0
fi
\`\`\`

---

## Script 2: soa_tls_wls_check.py (WLST)

\`\`\`python
# soa_tls_wls_check.py — WLST sub-script for WebLogic MBean TLS verification
# Called by soa_tls_verify.sh as: java weblogic.WLST this_script.py <host> <port> <user> <pass>
import sys

admin_host = sys.argv[1] if len(sys.argv) > 1 else 'admin-server.company.com'
admin_port = sys.argv[2] if len(sys.argv) > 2 else '7002'
wls_user   = sys.argv[3] if len(sys.argv) > 3 else 'weblogic'
wls_pass   = sys.argv[4] if len(sys.argv) > 4 else 'password'

try:
    connect(wls_user, wls_pass, 't3s://' + admin_host + ':' + admin_port)
except Exception as e:
    print('[UNKNOWN] Cannot connect to WebLogic Admin: ' + str(e))
    exit(3)

servers = ['soa_server1', 'osb_server1', 'AdminServer']

for srv in servers:
    try:
        cd('/Servers/' + srv + '/SSL/' + srv)
        ssl_on  = cmo.getEnabled()
        min_tls = cmo.getMinimumTLSProtocolVersion()
        two_way = cmo.getTwoWaySSLEnabled()

        if not ssl_on:
            print('[FAIL] ' + srv + ' SSL listener is DISABLED')
        else:
            print('[OK] ' + srv + ' SSL listener enabled')

        if str(min_tls) == 'TLSv1.2':
            print('[OK] ' + srv + ' MinimumTLSProtocolVersion = TLSv1.2')
        else:
            print('[FAIL] ' + srv + ' MinimumTLSProtocolVersion = ' + str(min_tls) + ' (expected TLSv1.2)')

        cd('/Servers/' + srv)
        keystores = cmo.getKeyStores()
        if 'CustomIdentity' in str(keystores):
            print('[OK] ' + srv + ' uses CustomIdentity keystore')
        else:
            print('[FAIL] ' + srv + ' not using CustomIdentityAndCustomTrust — using: ' + str(keystores))

    except Exception as e:
        print('[UNKNOWN] ' + srv + ' MBean read error: ' + str(e))

try:
    cd('/SecurityConfiguration/soa_domain/DefaultRealm/myrealm')
    providers = cmo.getAuthenticationProviders()
    for p in providers:
        try:
            if hasattr(p, 'getPort') and hasattr(p, 'getSSLEnabled'):
                port     = p.getPort()
                ssl_on   = p.getSSLEnabled()
                p_name   = p.getName()
                if port == 636 and ssl_on:
                    print('[OK] LDAP provider ' + p_name + ' port=636 SSL=true')
                elif port != 636:
                    print('[FAIL] LDAP provider ' + p_name + ' port=' + str(port) + ' (expected 636)')
                elif not ssl_on:
                    print('[FAIL] LDAP provider ' + p_name + ' SSL disabled')
        except Exception:
            pass
except Exception as e:
    print('[UNKNOWN] Cannot read LDAP provider config: ' + str(e))

disconnect()
\`\`\`

---

## Script 3: soa_tls_endpoints.conf

\`\`\`
# soa_tls_endpoints.conf — External HTTPS endpoints called by SOA composites
# Format: hostname|port|label
# Lines starting with # are ignored
#
# Add one line per partner/API that SOA composites or OSB business services call
partner1.company.com|443|Partner1 Integration API
api.paymentgateway.com|443|Payment Gateway
erp.partner2.com|8443|Partner2 ERP SOAP
sftp-api.bank.com|443|Bank Transfer API
\`\`\`

---

## Deployment

\`\`\`bash
# Create script directory and log directory
mkdir -p /u01/oracle/scripts
mkdir -p /u01/oracle/logs/tls_verify

# Deploy scripts
cp soa_tls_verify.sh     /u01/oracle/scripts/
cp soa_tls_wls_check.py  /u01/oracle/scripts/
cp soa_tls_endpoints.conf /u01/oracle/scripts/

# Set permissions
chmod 750 /u01/oracle/scripts/soa_tls_verify.sh
chmod 640 /u01/oracle/scripts/soa_tls_wls_check.py
chmod 640 /u01/oracle/scripts/soa_tls_endpoints.conf
chown oracle:oinstall /u01/oracle/scripts/soa_tls_verify.sh
chown oracle:oinstall /u01/oracle/scripts/soa_tls_wls_check.py

# Source the WebLogic environment (needed for java weblogic.WLST in the script)
echo ". /u01/oracle/config/domains/soa_domain/bin/setDomainEnv.sh 2>/dev/null" >> /home/oracle/.bashrc

# Test run — no email, verbose output
/u01/oracle/scripts/soa_tls_verify.sh --verbose --no-email
echo "Exit code: \$?"
\`\`\`

---

## Cron Schedule

\`\`\`bash
# Add to oracle user crontab: crontab -e
# Full verification daily at 06:00
0 6 * * * . /u01/oracle/config/domains/soa_domain/bin/setDomainEnv.sh 2>/dev/null; /u01/oracle/scripts/soa_tls_verify.sh >> /u01/oracle/logs/tls_verify/cron.log 2>&1

# Certificate-only quick check every 4 hours
0 */4 * * * . /u01/oracle/config/domains/soa_domain/bin/setDomainEnv.sh 2>/dev/null; /u01/oracle/scripts/soa_tls_verify.sh --certs-only --no-email >> /u01/oracle/logs/tls_verify/cron_certs.log 2>&1
\`\`\`

---

## Log Rotation

\`\`\`bash
cat > /etc/logrotate.d/soa-tls-verify << 'EOF'
/u01/oracle/logs/tls_verify/tls_verify_*.log {
    daily
    rotate 60
    compress
    missingok
    notifempty
    dateext
    dateformat _%Y%m%d
}
/u01/oracle/logs/tls_verify/cron*.log {
    weekly
    rotate 12
    compress
    missingok
}
EOF
\`\`\`

---

## Expected Output — Clean Environment

\`\`\`
SOA Suite 12c TLS 1.2 Verification — Sun Jun  7 06:00:01 UTC 2026
Host: soa_server1.company.com
Domain: /u01/oracle/config/domains/soa_domain
======================================================

## Layer 1: OHS Inbound TLS

[OK]       OHS soa.company.com:443 TLS 1.2 accepted — proto:TLSv1.2 cipher:ECDHE-RSA-AES256-GCM-SHA384
[OK]       OHS soa.company.com:443 TLS 1.1 correctly rejected
[OK]       OHS soa.company.com:443 TLS 1.0 correctly rejected
[OK]       OHS browser-facing cert valid for 312d (Jun  2 2027)
[OK]       OHS proxy path /soa-infra → HTTP 302
[OK]       OHS proxy path /sbconsole → HTTP 302
[OK]       OHS proxy path /em → HTTP 302

## Layer 2: WebLogic SSL Listeners

[OK]       WLS soa_server1 soa_server1.company.com:8002 TLS 1.2 accepted — proto:TLSv1.2 cipher:ECDHE-RSA-AES256-GCM-SHA384
[OK]       WLS soa_server1 soa_server1.company.com:8002 TLS 1.1 correctly rejected
[OK]       WLS soa_server1 cert valid for 298d
[OK]       WLS osb_server1 osb_server1.company.com:7005 TLS 1.2 accepted
[OK]       WLS osb_server1 TLS 1.1 correctly rejected
[OK]       WLS osb_server1 cert valid for 298d
[OK]       WLS identity JKS alias 'soa-server' valid for 298d
[OK]       soa_server1 HTTP port soa_server1.company.com:8001 is closed (plain HTTP correctly disabled)
[OK]       osb_server1 HTTP port osb_server1.company.com:7004 is closed

## Layer 3: JVM TLS Enforcement Flags

[OK]       soa_server1 JVM flag 'disabledAlgorithms' found in PID 24381
[OK]       soa_server1 JVM flag 'javax.net.ssl.trustStore' found in PID 24381
[OK]       setDomainEnv.sh contains -Djdk.tls.disabledAlgorithms
[OK]       setDomainEnv.sh contains -Djavax.net.ssl.trustStore

## Layer 4: WebLogic TLS Configuration (WLST)

[OK]       soa_server1 SSL listener enabled
[OK]       soa_server1 MinimumTLSProtocolVersion = TLSv1.2
[OK]       soa_server1 uses CustomIdentity keystore
[OK]       LDAP provider OID_Authenticator port=636 SSL=true

## Layer 5: LDAPS Identity Store

[OK]       LDAPS oid-server.company.com:636 TLS 1.2 accepted
[OK]       LDAPS oid-server.company.com:636 TLS 1.1 correctly rejected
[OK]       OID LDAPS cert valid for 187d
[OK]       LDAPS anonymous base search — result: 0 Success

## Layer 6: TCPS Database Connection

[OK]       DB TCPS db-server.company.com:1522 TLS 1.2 accepted
[OK]       DB TCPS cert valid for 201d
[OK]       DataSource SOADataSource state=Running failedReserves=0
[OK]       DataSource mds-soa state=Running failedReserves=0
[OK]       DataSource mds-owsm state=Running failedReserves=0

## Layer 7: Trust JKS Outbound Coverage

[OK]       Trust JKS contains 8 trusted CA entries
[WARNING]  Trust JKS alias 'partner-ca' expires in 67d (Aug 13 2026)

## Layer 7b: Outbound Composite Endpoint TLS Check

[OK]       Outbound: Partner1 Integration API partner1.company.com:443 TLS 1.2 accepted
[OK]       Outbound: Payment Gateway api.paymentgateway.com:443 TLS 1.2 accepted

======================================================
SUMMARY: 28 OK  1 WARNING  0 FAIL/CRITICAL  0 UNKNOWN
Run completed: Sun Jun  7 06:00:47 UTC 2026
\`\`\``,
};

async function main() {
  console.log('Inserting SOA TLS verification runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
