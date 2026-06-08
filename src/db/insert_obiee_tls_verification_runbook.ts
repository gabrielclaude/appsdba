import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OBIEE 12c TLS 1.2 Verification Runbook: Scripted Health Check for OHS, WebLogic, BI Server, and Data Sources',
  slug: 'oracle-obiee-tls-1-2-verification-runbook',
  excerpt:
    'Complete production-ready scripts for verifying TLS 1.2 compliance across the OBIEE 12c topology: shell verification functions for every layer (OHS, WebLogic bi_server1, JVM flags, LDAPS, TCPS BI data sources, RPD connection pool, BI Publisher, Node Manager), a WLST WebLogic configuration reader, Nagios-compatible exit codes, cron scheduling, email alerting, and annotated expected output.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook delivers the complete TLS 1.2 verification script set for Oracle OBIEE 12c. The main script \`obiee_tls_verify.sh\` checks every TLS channel in the OBIEE topology: OHS inbound, WebLogic bi_server1 SSL listener, JVM flags in the running BI domain processes, LDAPS authentication source, TCPS database connections for BI data sources, BI Publisher data sources, Node Manager SSL, and certificate expiry across all keystores and wallets. A WLST sub-script reads the live WebLogic MBeans to confirm \`MinimumTLSProtocolVersion\` and LDAP provider configuration without relying on configuration files that may not reflect the active state.

---

## File Layout

\`\`\`
/u01/oracle/scripts/
├── obiee_tls_verify.sh          # Main verification script
├── obiee_tls_wls_check.py       # WLST sub-script for WebLogic MBean checks
└── obiee_tls_datasources.conf   # BI data source TCPS endpoints to verify

/u01/oracle/logs/
└── obiee_tls_verify/
    ├── tls_verify_YYYYMMDD_HHMMSS.log
    └── tls_verify_latest.log    # Symlink to most recent run
\`\`\`

---

## Script 1: obiee_tls_verify.sh

\`\`\`bash
#!/bin/bash
# =============================================================================
# obiee_tls_verify.sh — OBIEE 12c TLS 1.2 Comprehensive Verification Script
# Nagios-compatible exit codes: 0=OK  1=WARNING  2=CRITICAL  3=UNKNOWN
# Usage: ./obiee_tls_verify.sh [--certs-only] [--verbose] [--no-email]
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIGURATION — edit for your environment
# =============================================================================
OHS_HOST="obiee.company.com"
OHS_PORT=443

WLS_HOST="bi_server1.company.com"
WLS_SSL_PORT=9502
WLS_HTTP_PORT=9500

ADMIN_HOST="admin-server.company.com"
ADMIN_SSL_PORT=7002
ADMIN_HTTP_PORT=7001

OID_HOST="oid-server.company.com"
LDAPS_PORT=636

DB_HOST="db-server.company.com"
TCPS_PORT=1522

DOMAIN_HOME="/u01/oracle/config/domains/bi_domain"
IDENTITY_JKS="/u01/oracle/keystores/obiee-identity.jks"
IDENTITY_PASS="Identity1"
IDENTITY_ALIAS="obiee-server"
TRUST_JKS="/u01/oracle/keystores/obiee-trust.jks"
TRUST_PASS="TrustStore1"
OHS_WALLET="\${DOMAIN_HOME}/config/fmwconfig/components/OHS/ohs1/keystores/default"
BI_TCPS_WALLET="/u01/oracle/bi_wallet"

WLS_USER="weblogic"
WLS_PASS="WlsPassword1"
WLST_SCRIPT="/u01/oracle/scripts/obiee_tls_wls_check.py"
DATASOURCES_CONF="/u01/oracle/scripts/obiee_tls_datasources.conf"

LOG_DIR="/u01/oracle/logs/obiee_tls_verify"
LOG_FILE="\${LOG_DIR}/tls_verify_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-team@company.com"
FROM_EMAIL="obiee-monitor@company.com"
SCRIPT_HOST=\$(hostname -f)

WARN_DAYS=90
CRIT_DAYS=30

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
    printf "[%-8s] %s\n" "\${status}" "\${msg}" | tee -a "\$LOG_FILE"
    case "\$status" in
        OK)            PASS_COUNT=\$((PASS_COUNT+1)) ;;
        WARNING)       WARN_COUNT=\$((WARN_COUNT+1)) ;;
        FAIL|CRITICAL) FAIL_COUNT=\$((FAIL_COUNT+1)) ;;
        UNKNOWN)       UNKNOWN_COUNT=\$((UNKNOWN_COUNT+1)) ;;
    esac
}

section() {
    printf "\n## %s\n\n" "\$1" | tee -a "\$LOG_FILE"
}

# =============================================================================
# HELPER: TLS HANDSHAKE — check_tls HOST PORT VERSION LABEL
# VERSION: tls1_2 (expect CONNECTED=pass) | tls1_1 | tls1 (expect rejection=pass)
# =============================================================================
check_tls() {
    local host="\$1" port="\$2" version="\$3" label="\$4"
    local result cipher proto
    result=\$(echo | timeout 10 openssl s_client \
        -connect "\${host}:\${port}" -servername "\${host}" \
        -"\${version}" 2>&1 || true)

    if [ "\$version" = "tls1_2" ]; then
        if echo "\$result" | grep -q "CONNECTED"; then
            cipher=\$(echo "\$result" | grep "Cipher is" | awk '{print \$NF}')
            proto=\$(echo  "\$result" | grep "Protocol  :" | awk '{print \$NF}')
            record "OK" "\${label} TLS 1.2 accepted — \${proto} \${cipher}"
        else
            record "FAIL" "\${label} TLS 1.2 NOT accepted — \$(echo \$result | grep -oE 'error|alert [a-z ]+' | head -1)"
        fi
    else
        local vlabel; case "\$version" in tls1_1) vlabel="TLS 1.1";; tls1) vlabel="TLS 1.0";; *) vlabel="\$version";; esac
        if echo "\$result" | grep -qE "handshake failure|alert|no protocols available"; then
            record "OK" "\${label} \${vlabel} correctly rejected"
        elif echo "\$result" | grep -q "CONNECTED"; then
            record "FAIL" "\${label} \${vlabel} NOT rejected — insecure protocol accepted"
        else
            record "UNKNOWN" "\${label} \${vlabel} — timeout or unreachable"
        fi
    fi
}

# =============================================================================
# HELPER: CERTIFICATE EXPIRY FROM LIVE TLS ENDPOINT
# =============================================================================
check_cert_expiry() {
    local host="\$1" port="\$2" label="\$3"
    local expiry days_left
    expiry=\$(echo | timeout 10 openssl s_client \
        -connect "\${host}:\${port}" -servername "\${host}" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "\$expiry" ]; then
        record "UNKNOWN" "\${label} cert — cannot retrieve from \${host}:\${port}"
        return
    fi
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null || \
        date -j -f "%b %d %T %Y %Z" "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
    if   [ "\$days_left" -le "\$CRIT_DAYS" ]; then
        record "CRITICAL" "\${label} cert expires in \${days_left}d (\$expiry) — RENEW IMMEDIATELY"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
        record "WARNING"  "\${label} cert expires in \${days_left}d (\$expiry)"
    else
        record "OK"       "\${label} cert valid for \${days_left}d (\$expiry)"
    fi
}

# =============================================================================
# HELPER: JKS SINGLE ALIAS EXPIRY
# =============================================================================
check_jks_expiry() {
    local jks="\$1" pass="\$2" alias="\$3" label="\$4"
    [ ! -f "\$jks" ] && { record "UNKNOWN" "\${label} — JKS not found: \$jks"; return; }
    local expiry days_left
    expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$pass" -alias "\$alias" 2>/dev/null \
        | grep "Valid from" | sed 's/.*until: //')
    [ -z "\$expiry" ] && { record "UNKNOWN" "\${label} — alias '\$alias' not in JKS"; return; }
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
    if   [ "\$days_left" -le "\$CRIT_DAYS" ]; then record "CRITICAL" "\${label} alias '\$alias' expires \${days_left}d (\$expiry)"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then record "WARNING"  "\${label} alias '\$alias' expires \${days_left}d (\$expiry)"
    else record "OK" "\${label} alias '\$alias' valid \${days_left}d"; fi
}

# =============================================================================
# HELPER: ALL ALIASES IN A JKS
# =============================================================================
check_all_jks_expiry() {
    local jks="\$1" pass="\$2" label="\$3"
    [ ! -f "\$jks" ] && { record "UNKNOWN" "\${label} — JKS not found: \$jks"; return; }
    local aliases
    aliases=\$(keytool -list -keystore "\$jks" -storepass "\$pass" 2>/dev/null \
        | grep -E "trustedCertEntry|PrivateKeyEntry" | cut -d, -f1)
    local alias_count=0
    while IFS= read -r alias; do
        alias=\$(echo "\$alias" | xargs)
        [ -z "\$alias" ] && continue
        alias_count=\$((alias_count+1))
        local expiry days_left
        expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$pass" -alias "\$alias" 2>/dev/null \
            | grep "Valid from" | sed 's/.*until: //')
        [ -z "\$expiry" ] && continue
        days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
        if   [ "\$days_left" -le "\$CRIT_DAYS" ]; then record "CRITICAL" "\${label} alias '\$alias' expires \${days_left}d (\$expiry)"
        elif [ "\$days_left" -le "\$WARN_DAYS" ]; then record "WARNING"  "\${label} alias '\$alias' expires \${days_left}d (\$expiry)"
        elif [ "\$VERBOSE" = "true" ]; then record "OK" "\${label} alias '\$alias' valid \${days_left}d"; fi
    done <<< "\$aliases"
    record "OK" "\${label} scanned \${alias_count} aliases"
}

# =============================================================================
# HELPER: ORACLE WALLET CERTIFICATE EXPIRY
# =============================================================================
check_wallet_expiry() {
    local wallet="\$1" label="\$2"
    [ ! -d "\$wallet" ] && { record "UNKNOWN" "\${label} — wallet not found: \$wallet"; return; }
    command -v orapki &>/dev/null || { record "UNKNOWN" "\${label} — orapki not in PATH"; return; }
    local found=0
    while IFS= read -r line; do
        if echo "\$line" | grep -qiE "Not After|notAfter|valid until"; then
            local expiry days_left
            expiry=\$(echo "\$line" | sed 's/.*: *//')
            days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 )) 2>/dev/null || continue
            found=\$((found+1))
            if   [ "\$days_left" -le "\$CRIT_DAYS" ]; then record "CRITICAL" "\${label} wallet cert expires \${days_left}d (\$expiry)"
            elif [ "\$days_left" -le "\$WARN_DAYS" ]; then record "WARNING"  "\${label} wallet cert expires \${days_left}d (\$expiry)"
            elif [ "\$VERBOSE" = "true" ]; then record "OK" "\${label} wallet cert valid \${days_left}d"; fi
        fi
    done < <(orapki wallet display -wallet "\$wallet" 2>/dev/null)
    [ "\$found" -eq 0 ] && record "UNKNOWN" "\${label} — no cert expiry dates found in wallet output"
}

# =============================================================================
# HELPER: JVM FLAG IN RUNNING PROCESS
# =============================================================================
check_jvm_flag() {
    local server_name="\$1" flag="\$2" label="\$3"
    local pid cmdline
    pid=\$(pgrep -f "weblogic.Name=\${server_name}" 2>/dev/null | head -1)
    if [ -z "\$pid" ]; then
        record "UNKNOWN" "\${label} — server '\${server_name}' not running (PID not found)"
        return
    fi
    if [ -f "/proc/\${pid}/cmdline" ]; then
        cmdline=\$(tr '\\0' '\\n' < "/proc/\${pid}/cmdline" 2>/dev/null | tr '\\n' ' ')
    else
        cmdline=\$(ps -p "\$pid" -o args= 2>/dev/null)
    fi
    if echo "\$cmdline" | grep -q "\$flag"; then
        record "OK" "\${label} JVM flag '\${flag}' active in PID \${pid}"
    else
        record "FAIL" "\${label} JVM flag '\${flag}' NOT in PID \${pid} — flag absent or server needs restart"
    fi
}

# =============================================================================
# HELPER: PORT OPEN/CLOSED CHECK
# =============================================================================
check_port() {
    local host="\$1" port="\$2" label="\$3" expect="\$4"
    if timeout 5 bash -c "echo > /dev/tcp/\${host}/\${port}" 2>/dev/null; then
        if [ "\$expect" = "open" ];   then record "OK"   "\${label} port \${host}:\${port} open"
        else record "FAIL" "\${label} port \${host}:\${port} OPEN — plain HTTP not disabled"; fi
    else
        if [ "\$expect" = "closed" ]; then record "OK"   "\${label} port \${host}:\${port} closed (plain HTTP disabled)"
        else record "UNKNOWN" "\${label} port \${host}:\${port} not reachable"; fi
    fi
}

# =============================================================================
# LAYER 1: OHS INBOUND TLS
# =============================================================================
check_layer1_ohs() {
    section "Layer 1: OHS Inbound TLS"

    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1_2" "OHS \${OHS_HOST}:\${OHS_PORT}"
    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1_1" "OHS \${OHS_HOST}:\${OHS_PORT}"
    check_tls "\$OHS_HOST" "\$OHS_PORT" "tls1"   "OHS \${OHS_HOST}:\${OHS_PORT}"

    check_cert_expiry "\$OHS_HOST" "\$OHS_PORT" "OHS browser-facing"
    check_wallet_expiry "\$OHS_WALLET" "OHS Oracle Wallet"

    # Verify that ssl.conf contains SSLProtocol -ALL +TLSv1.2
    local ssl_conf="\${DOMAIN_HOME}/config/fmwconfig/components/OHS/ohs1/ssl.conf"
    if [ -f "\$ssl_conf" ]; then
        if grep -q "SSLProtocol.*-ALL.*TLSv1.2" "\$ssl_conf"; then
            record "OK" "ssl.conf SSLProtocol includes -ALL +TLSv1.2"
        elif grep -q "SSLProtocol" "\$ssl_conf"; then
            local proto_line
            proto_line=\$(grep "SSLProtocol" "\$ssl_conf" | head -1 | xargs)
            record "FAIL" "ssl.conf SSLProtocol misconfigured: '\${proto_line}' — missing -ALL prefix"
        else
            record "FAIL" "ssl.conf has no SSLProtocol directive — TLS version unrestricted"
        fi

        # Verify mod_wl_ohs uses WebLogicSSLPort (not plain WebLogicPort) for /analytics
        if grep -q "WebLogicSSLPort" "\$ssl_conf"; then
            record "OK" "ssl.conf uses WebLogicSSLPort (OHS→WLS HTTPS proxy active)"
        else
            record "FAIL" "ssl.conf uses WebLogicPort (plain HTTP to WLS) — OHS→WLS not encrypted"
        fi
    else
        record "UNKNOWN" "ssl.conf not found at \$ssl_conf"
    fi

    # OBIEE key paths via OHS
    for path in "/analytics" "/xmlpserver" "/em"; do
        local http_code
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
# LAYER 2: WEBLOGIC bi_server1 SSL LISTENER
# =============================================================================
check_layer2_wls() {
    section "Layer 2: WebLogic bi_server1 SSL Listener"

    check_tls "\$WLS_HOST" "\$WLS_SSL_PORT" "tls1_2" "WLS bi_server1 \${WLS_HOST}:\${WLS_SSL_PORT}"
    check_tls "\$WLS_HOST" "\$WLS_SSL_PORT" "tls1_1" "WLS bi_server1 \${WLS_HOST}:\${WLS_SSL_PORT}"
    check_tls "\$WLS_HOST" "\$WLS_SSL_PORT" "tls1"   "WLS bi_server1 \${WLS_HOST}:\${WLS_SSL_PORT}"

    check_tls "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "tls1_2" "WLS AdminServer \${ADMIN_HOST}:\${ADMIN_SSL_PORT}"
    check_tls "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "tls1_1" "WLS AdminServer \${ADMIN_HOST}:\${ADMIN_SSL_PORT}"

    check_cert_expiry "\$WLS_HOST"   "\$WLS_SSL_PORT"   "WLS bi_server1 cert"
    check_cert_expiry "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "WLS AdminServer cert"
    check_jks_expiry  "\$IDENTITY_JKS" "\$IDENTITY_PASS" "\$IDENTITY_ALIAS" "WLS identity JKS"

    # Plain HTTP should be closed after hardening
    check_port "\$WLS_HOST"  "\$WLS_HTTP_PORT"  "bi_server1 HTTP"  "closed"
    check_port "\$ADMIN_HOST" "\$ADMIN_HTTP_PORT" "AdminServer HTTP" "closed"

    # Verify cipher suite strength on bi_server1
    local cipher
    cipher=\$(echo | timeout 10 openssl s_client \
        -connect "\${WLS_HOST}:\${WLS_SSL_PORT}" 2>/dev/null | grep "Cipher is" | awk '{print \$NF}')
    if echo "\$cipher" | grep -qiE "GCM|ECDHE"; then
        record "OK" "WLS bi_server1 cipher: \${cipher} (forward-secret GCM suite)"
    elif [ -n "\$cipher" ]; then
        record "WARNING" "WLS bi_server1 cipher: \${cipher} — consider GCM/ECDHE suite"
    fi
}

# =============================================================================
# LAYER 3: JVM TLS ENFORCEMENT FLAGS
# =============================================================================
check_layer3_jvm() {
    section "Layer 3: JVM TLS Enforcement Flags"

    local setenv="\${DOMAIN_HOME}/bin/setDomainEnv.sh"

    # Running process checks
    for server_name in "bi_server1" "AdminServer"; do
        check_jvm_flag "\$server_name" "disabledAlgorithms" "\$server_name"
        check_jvm_flag "\$server_name" "javax.net.ssl.trustStore" "\$server_name"
        check_jvm_flag "\$server_name" "TLSv1.1" "\$server_name TLSv1.1 in disabledAlgorithms"
    done

    # Persistence check — flags must survive restart
    if [ -f "\$setenv" ]; then
        local checks=(
            "disabledAlgorithms:setDomainEnv.sh -Djdk.tls.disabledAlgorithms"
            "javax.net.ssl.trustStore:setDomainEnv.sh -Djavax.net.ssl.trustStore"
            "TLSv1.1:setDomainEnv.sh TLSv1.1 in disabledAlgorithms"
        )
        for check in "\${checks[@]}"; do
            local pattern="\${check%%:*}" desc="\${check##*:}"
            if grep -q "\$pattern" "\$setenv"; then
                record "OK" "\${desc} present"
            else
                record "FAIL" "\${desc} MISSING — lost on next restart"
            fi
        done

        # Verify trust JKS path in setDomainEnv.sh references the correct file
        if grep -q "\$TRUST_JKS" "\$setenv"; then
            record "OK" "setDomainEnv.sh trustStore references correct JKS: \$TRUST_JKS"
        else
            record "FAIL" "setDomainEnv.sh trustStore path does not match \$TRUST_JKS"
        fi
    else
        record "UNKNOWN" "setDomainEnv.sh not found at \$setenv"
    fi
}

# =============================================================================
# LAYER 4: WEBLOGIC MBEAN CONFIGURATION VIA WLST
# =============================================================================
check_layer4_wls_config() {
    section "Layer 4: WebLogic TLS Configuration (WLST MBean Read)"

    if [ ! -f "\$WLST_SCRIPT" ]; then
        record "UNKNOWN" "WLST script not found at \$WLST_SCRIPT — skipping MBean verification"
        return
    fi

    local wlst_out
    wlst_out=\$(java weblogic.WLST "\$WLST_SCRIPT" \
        "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "\$WLS_USER" "\$WLS_PASS" 2>/dev/null || true)

    while IFS= read -r line; do
        if echo "\$line" | grep -qE "^\[(OK|FAIL|WARNING|CRITICAL|UNKNOWN)\]"; then
            local status msg
            status=\$(echo "\$line" | grep -oP '(?<=\[)[A-Z]+(?=\])')
            msg=\$(echo "\$line" | sed 's/^\[[A-Z]*\] //')
            record "\$status" "\$msg"
        fi
    done <<< "\$wlst_out"
}

# =============================================================================
# LAYER 5: LDAPS IDENTITY STORE
# =============================================================================
check_layer5_ldaps() {
    section "Layer 5: LDAPS Authentication Source"

    check_tls "\$OID_HOST" "\$LDAPS_PORT" "tls1_2" "LDAPS \${OID_HOST}:\${LDAPS_PORT}"
    check_tls "\$OID_HOST" "\$LDAPS_PORT" "tls1_1" "LDAPS \${OID_HOST}:\${LDAPS_PORT}"
    check_cert_expiry "\$OID_HOST" "\$LDAPS_PORT" "OID LDAPS cert"

    # Live anonymous base search — tests TLS handshake + connectivity
    local ldap_out
    ldap_out=\$(timeout 10 ldapsearch \
        -H "ldaps://\${OID_HOST}:\${LDAPS_PORT}" \
        -x -b "dc=company,dc=com" -s base "(objectclass=*)" 2>&1 || true)
    if echo "\$ldap_out" | grep -q "result: 0"; then
        record "OK" "LDAPS anonymous base search succeeded"
    elif echo "\$ldap_out" | grep -qE "result: 32|No such object"; then
        record "OK" "LDAPS TLS handshake succeeded (base DN lookup returned no such object — expected)"
    else
        record "FAIL" "LDAPS search failed: \$(echo \$ldap_out | head -c 100)"
    fi

    # Check OID CA is in the OBIEE trust JKS
    if [ -f "\$TRUST_JKS" ]; then
        local oid_ca_count
        oid_ca_count=\$(keytool -list -keystore "\$TRUST_JKS" -storepass "\$TRUST_PASS" 2>/dev/null \
            | grep -ic "oid\|ldap\|directory" || echo "0")
        if [ "\$oid_ca_count" -gt 0 ]; then
            record "OK" "Trust JKS contains \${oid_ca_count} OID/LDAP-related CA alias(es)"
        else
            record "WARNING" "Trust JKS has no OID/LDAP CA alias — verify OID CA is included under any alias"
        fi
    fi
}

# =============================================================================
# LAYER 6: TCPS DATABASE CONNECTIONS
# =============================================================================
check_layer6_tcps() {
    section "Layer 6: TCPS Database and BI Data Sources"

    # TCPS port TLS version check
    check_tls "\$DB_HOST" "\$TCPS_PORT" "tls1_2" "DB TCPS \${DB_HOST}:\${TCPS_PORT}"
    check_cert_expiry "\$DB_HOST" "\$TCPS_PORT" "DB TCPS cert"
    check_port "\$DB_HOST" "\$TCPS_PORT" "DB TCPS port" "open"

    # BI TCPS wallet
    check_wallet_expiry "\$BI_TCPS_WALLET" "BI Server TCPS wallet"

    # sqlnet.ora SSL_VERSION on BI Server host
    local sqlnet="\${DOMAIN_HOME}/../../../Oracle_Home/network/admin/sqlnet.ora"
    # Try common sqlnet.ora paths
    for candidate in \
        "\${DOMAIN_HOME}/../../../Oracle_Home/network/admin/sqlnet.ora" \
        "/u01/oracle/middleware/Oracle_Home/network/admin/sqlnet.ora" \
        "\$ORACLE_HOME/network/admin/sqlnet.ora"; do
        if [ -f "\$candidate" ]; then
            sqlnet="\$candidate"; break
        fi
    done
    if [ -f "\$sqlnet" ]; then
        local ssl_ver
        ssl_ver=\$(grep -i "SSL_VERSION" "\$sqlnet" | grep -oP '[\d.]+' | head -1)
        if [ "\$ssl_ver" = "1.2" ]; then
            record "OK" "sqlnet.ora SSL_VERSION = 1.2 (\$sqlnet)"
        elif [ -n "\$ssl_ver" ]; then
            record "FAIL" "sqlnet.ora SSL_VERSION = \${ssl_ver} (expected 1.2)"
        else
            record "FAIL" "sqlnet.ora has no SSL_VERSION directive — TCPS may not enforce TLS 1.2"
        fi

        local wallet_path
        wallet_path=\$(grep -A3 "WALLET_LOCATION" "\$sqlnet" | grep "DIRECTORY" | grep -oP '"[^"]+"' | tr -d '"')
        if [ -n "\$wallet_path" ] && [ -d "\$wallet_path" ]; then
            record "OK" "sqlnet.ora wallet path exists: \$wallet_path"
            check_wallet_expiry "\$wallet_path" "sqlnet.ora wallet"
        else
            record "FAIL" "sqlnet.ora wallet path not found or missing: '\${wallet_path}'"
        fi
    else
        record "UNKNOWN" "sqlnet.ora not found — checked common paths"
    fi

    # DataSource health via WebLogic REST API for bi_server1
    local base_url="https://\${ADMIN_HOST}:\${ADMIN_SSL_PORT}/management/weblogic/latest/domainRuntime/serverRuntimes"
    for ds in "BIDS" "biDataSource" "mds-owsm"; do
        local ds_url="\${base_url}/bi_server1/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/\${ds}"
        local ds_info state failed_count
        ds_info=\$(curl -s -k -u "\${WLS_USER}:\${WLS_PASS}" --max-time 10 "\$ds_url" 2>/dev/null || true)
        if [ -z "\$ds_info" ]; then
            [ "\$VERBOSE" = "true" ] && record "UNKNOWN" "DataSource \${ds} — REST API no response (may not exist)"
            continue
        fi
        state=\$(echo "\$ds_info" | python3 -c \
            "import sys,json; d=json.load(sys.stdin); print(d.get('state','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
        failed_count=\$(echo "\$ds_info" | python3 -c \
            "import sys,json; d=json.load(sys.stdin); print(d.get('failedReserveRequestCount',0))" 2>/dev/null || echo "-")
        if [ "\$state" = "Running" ] && [ "\$failed_count" = "0" ]; then
            record "OK" "DataSource \${ds} state=\${state} failedReserves=\${failed_count}"
        elif [ "\$state" = "Running" ]; then
            record "WARNING" "DataSource \${ds} state=\${state} failedReserves=\${failed_count}"
        else
            record "FAIL" "DataSource \${ds} state=\${state} failedReserves=\${failed_count}"
        fi
    done

    # Verify DataSource URLs in config.xml use TCPS (not plain TCP)
    local config_xml="\${DOMAIN_HOME}/config/config.xml"
    if [ -f "\$config_xml" ]; then
        local plain_count
        plain_count=\$(grep -A5 "jdbc-driver-params" "\$config_xml" 2>/dev/null \
            | grep "url" | grep "oracle:thin" | grep -v "TCPS\|tcps\|1522" | wc -l)
        if [ "\$plain_count" -gt 0 ]; then
            record "FAIL" "config.xml: \${plain_count} DataSource URL(s) use plain TCP — update to TCPS"
        else
            record "OK" "config.xml: all Oracle DataSource URLs appear to use TCPS"
        fi
    fi

    # Additional TCPS endpoints from datasources.conf
    if [ -f "\$DATASOURCES_CONF" ]; then
        section "Layer 6b: Additional BI Data Source TCPS Endpoints"
        while IFS='|' read -r host port label || [ -n "\$host" ]; do
            [[ "\$host" =~ ^#.*$ || -z "\$host" ]] && continue
            host=\$(echo "\$host" | xargs); port=\$(echo "\$port" | xargs); label=\$(echo "\$label" | xargs)
            check_tls "\$host" "\$port" "tls1_2" "BI DataSrc: \${label} \${host}:\${port}"
        done < "\$DATASOURCES_CONF"
    fi
}

# =============================================================================
# LAYER 7: BI PUBLISHER DATA SOURCES
# =============================================================================
check_layer7_bip() {
    section "Layer 7: BI Publisher Data Sources"

    # BI Publisher runs on bi_server1 — check xmlpserver endpoint
    local http_code
    http_code=\$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time 10 --insecure \
        "https://\${OHS_HOST}/xmlpserver" 2>/dev/null || echo "000")
    if [[ "\$http_code" =~ ^(200|302|401|403)$ ]]; then
        record "OK" "BI Publisher /xmlpserver reachable via OHS → HTTP \${http_code}"
    else
        record "FAIL" "BI Publisher /xmlpserver → HTTP \${http_code} (expected 200/302/401)"
    fi

    # BI Publisher JDBC data sources are managed via the BIP Admin console.
    # Verify by checking config.xml for any BIP-specific DataSources using plain TCP.
    local config_xml="\${DOMAIN_HOME}/config/config.xml"
    if [ -f "\$config_xml" ]; then
        local bip_plain
        bip_plain=\$(grep -B5 "oracle:thin" "\$config_xml" 2>/dev/null \
            | grep -i "bip\|xmlp\|publisher" | grep -v "TCPS\|tcps" | wc -l)
        if [ "\$bip_plain" -gt 0 ]; then
            record "WARNING" "config.xml: possible BIP DataSource(s) not using TCPS — review manually"
        else
            record "OK" "config.xml: no plain TCP BIP DataSources detected"
        fi
    fi
}

# =============================================================================
# LAYER 8: NODE MANAGER SSL
# =============================================================================
check_layer8_nm() {
    section "Layer 8: Node Manager SSL"

    local nm_props="\${DOMAIN_HOME}/nodemanager/nodemanager.properties"
    if [ -f "\$nm_props" ]; then
        local secure_listener
        secure_listener=\$(grep "^SecureListener" "\$nm_props" | cut -d= -f2 | xargs)
        if [ "\$secure_listener" = "true" ]; then
            record "OK" "nodemanager.properties SecureListener=true"
        else
            record "FAIL" "nodemanager.properties SecureListener=\${secure_listener:-not set} — Node Manager using plain socket"
        fi

        if grep -q "CustomIdentityKeyStoreFileName" "\$nm_props"; then
            record "OK" "nodemanager.properties references CustomIdentity keystore"
        else
            record "WARNING" "nodemanager.properties has no custom identity keystore — using demo certs"
        fi
    else
        record "UNKNOWN" "nodemanager.properties not found at \$nm_props"
    fi
}

# =============================================================================
# LAYER 9: TRUST JKS COVERAGE
# =============================================================================
check_layer9_trust_jks() {
    section "Layer 9: Trust JKS Coverage and Expiry"

    [ ! -f "\$TRUST_JKS" ] && { record "CRITICAL" "Trust JKS not found: \$TRUST_JKS"; return; }

    local alias_count
    alias_count=\$(keytool -list -keystore "\$TRUST_JKS" -storepass "\$TRUST_PASS" 2>/dev/null \
        | grep -c "trustedCertEntry" || echo "0")
    record "OK" "Trust JKS \${TRUST_JKS} contains \${alias_count} trusted CA entries"

    check_all_jks_expiry "\$TRUST_JKS" "\$TRUST_PASS" "Trust JKS"

    # Verify trust JKS is referenced in setDomainEnv.sh
    if grep -q "\$TRUST_JKS" "\${DOMAIN_HOME}/bin/setDomainEnv.sh" 2>/dev/null; then
        record "OK" "setDomainEnv.sh trustStore references: \$TRUST_JKS"
    else
        record "FAIL" "setDomainEnv.sh does not reference \$TRUST_JKS — outbound HTTPS may use JVM cacerts"
    fi
}

# =============================================================================
# MAIN
# =============================================================================
mkdir -p "\$LOG_DIR"
printf "OBIEE 12c TLS 1.2 Verification — %s\n" "\$(date)"      | tee "\$LOG_FILE"
printf "Host: %s\n" "\$SCRIPT_HOST"                              | tee -a "\$LOG_FILE"
printf "Domain: %s\n" "\$DOMAIN_HOME"                            | tee -a "\$LOG_FILE"
printf "%s\n" "======================================================" | tee -a "\$LOG_FILE"

if [ "\$CERTS_ONLY" = "true" ]; then
    section "Certificate Expiry Check (--certs-only)"
    check_cert_expiry  "\$OHS_HOST"   "\$OHS_PORT"    "OHS browser"
    check_cert_expiry  "\$WLS_HOST"   "\$WLS_SSL_PORT" "WLS bi_server1"
    check_cert_expiry  "\$ADMIN_HOST" "\$ADMIN_SSL_PORT" "WLS AdminServer"
    check_cert_expiry  "\$OID_HOST"   "\$LDAPS_PORT"  "OID LDAPS"
    check_cert_expiry  "\$DB_HOST"    "\$TCPS_PORT"   "DB TCPS"
    check_jks_expiry   "\$IDENTITY_JKS" "\$IDENTITY_PASS" "\$IDENTITY_ALIAS" "WLS identity"
    check_all_jks_expiry "\$TRUST_JKS" "\$TRUST_PASS" "Trust JKS"
    check_wallet_expiry "\$OHS_WALLET"    "OHS Oracle Wallet"
    check_wallet_expiry "\$BI_TCPS_WALLET" "BI TCPS wallet"
else
    check_layer1_ohs
    check_layer2_wls
    check_layer3_jvm
    check_layer4_wls_config
    check_layer5_ldaps
    check_layer6_tcps
    check_layer7_bip
    check_layer8_nm
    check_layer9_trust_jks
fi

printf "\n%s\n" "======================================================" | tee -a "\$LOG_FILE"
printf "SUMMARY: %d OK  %d WARNING  %d FAIL/CRITICAL  %d UNKNOWN\n" \
    "\$PASS_COUNT" "\$WARN_COUNT" "\$FAIL_COUNT" "\$UNKNOWN_COUNT" | tee -a "\$LOG_FILE"
printf "Completed: %s\n" "\$(date)" | tee -a "\$LOG_FILE"

ln -sf "\$LOG_FILE" "\${LOG_DIR}/tls_verify_latest.log"

if [ "\$NO_EMAIL" = "false" ] && [ \$((FAIL_COUNT + WARN_COUNT)) -gt 0 ]; then
    {
        echo "Subject: OBIEE TLS — \${FAIL_COUNT} FAIL \${WARN_COUNT} WARN on \${SCRIPT_HOST} \$(date +%Y-%m-%d)"
        echo "To: \${ALERT_EMAIL}"
        echo ""
        echo "OBIEE 12c TLS 1.2 Verification Report"
        echo "Host: \${SCRIPT_HOST}    Run: \$(date)"
        echo ""
        grep -E "^\[(FAIL|CRITICAL|WARNING|UNKNOWN)\]" "\$LOG_FILE"
        echo ""
        echo "Full log: \$LOG_FILE"
    } | sendmail "\$ALERT_EMAIL" 2>/dev/null || \
    grep -E "^\[(FAIL|CRITICAL|WARNING|UNKNOWN)\]" "\$LOG_FILE" | \
        mail -s "OBIEE TLS — \${FAIL_COUNT} FAIL \${WARN_COUNT} WARN on \${SCRIPT_HOST}" "\$ALERT_EMAIL"
fi

if   [ \$FAIL_COUNT    -gt 0 ]; then exit 2
elif [ \$WARN_COUNT    -gt 0 ]; then exit 1
elif [ \$UNKNOWN_COUNT -gt 0 ]; then exit 3
else exit 0; fi
\`\`\`

---

## Script 2: obiee_tls_wls_check.py (WLST)

\`\`\`python
# obiee_tls_wls_check.py — WLST sub-script for OBIEE WebLogic MBean TLS verification
# Called by obiee_tls_verify.sh as: java weblogic.WLST this_script.py <host> <port> <user> <pass>
import sys

admin_host = sys.argv[1] if len(sys.argv) > 1 else 'admin-server.company.com'
admin_port = sys.argv[2] if len(sys.argv) > 2 else '7002'
wls_user   = sys.argv[3] if len(sys.argv) > 3 else 'weblogic'
wls_pass   = sys.argv[4] if len(sys.argv) > 4 else 'password'

try:
    connect(wls_user, wls_pass, 't3s://' + admin_host + ':' + admin_port)
except Exception as e:
    print('[UNKNOWN] Cannot connect to Admin Server ' + admin_host + ':' + admin_port + ' — ' + str(e))
    exit(3)

# Check SSL configuration on bi_server1 and AdminServer
for srv in ['bi_server1', 'AdminServer']:
    try:
        cd('/Servers/' + srv + '/SSL/' + srv)
        ssl_on  = cmo.getEnabled()
        min_tls = cmo.getMinimumTLSProtocolVersion()
        two_way = cmo.getTwoWaySSLEnabled()

        if ssl_on:
            print('[OK] ' + srv + ' SSL listener enabled')
        else:
            print('[FAIL] ' + srv + ' SSL listener DISABLED')

        if str(min_tls) == 'TLSv1.2':
            print('[OK] ' + srv + ' MinimumTLSProtocolVersion = TLSv1.2')
        else:
            print('[FAIL] ' + srv + ' MinimumTLSProtocolVersion = ' + str(min_tls) + ' (expected TLSv1.2)')

        cd('/Servers/' + srv)
        keystores = str(cmo.getKeyStores())
        if 'CustomIdentity' in keystores and 'CustomTrust' in keystores:
            print('[OK] ' + srv + ' uses CustomIdentityAndCustomTrust keystores')
        else:
            print('[FAIL] ' + srv + ' keystore type: ' + keystores + ' — expected CustomIdentityAndCustomTrust')

        # Check SSL listen port is set to expected value
        ssl_port = None
        try:
            cd('/Servers/' + srv + '/SSL/' + srv)
            ssl_port = cmo.getListenPort()
        except Exception:
            pass
        if ssl_port:
            expected = 9502 if srv == 'bi_server1' else 7002
            if ssl_port == expected:
                print('[OK] ' + srv + ' SSL listen port = ' + str(ssl_port))
            else:
                print('[WARNING] ' + srv + ' SSL listen port = ' + str(ssl_port) + ' (expected ' + str(expected) + ')')

    except Exception as e:
        print('[UNKNOWN] ' + srv + ' MBean read error: ' + str(e))

# Check LDAP authentication provider
try:
    cd('/SecurityConfiguration/bi_domain/DefaultRealm/myrealm')
    providers = cmo.getAuthenticationProviders()
    ldap_found = False
    for p in providers:
        try:
            if hasattr(p, 'getPort') and hasattr(p, 'getSSLEnabled'):
                port   = p.getPort()
                ssl_on = p.getSSLEnabled()
                name   = p.getName()
                ldap_found = True
                if port == 636 and ssl_on:
                    print('[OK] LDAP provider ' + name + ' port=636 SSL=true (LDAPS)')
                elif port != 636:
                    print('[FAIL] LDAP provider ' + name + ' port=' + str(port) + ' (expected 636 for LDAPS)')
                elif not ssl_on:
                    print('[FAIL] LDAP provider ' + name + ' SSL=false (LDAPS requires SSL=true)')
        except Exception:
            pass
    if not ldap_found:
        print('[UNKNOWN] No LDAP authentication providers found in security realm')
except Exception as e:
    print('[UNKNOWN] Cannot read security realm providers: ' + str(e))

# Check HTTP listener disabled on bi_server1 (plain HTTP should be off after hardening)
try:
    cd('/Servers/bi_server1')
    http_enabled = cmo.isListenPortEnabled()
    if http_enabled:
        print('[FAIL] bi_server1 plain HTTP listen port is ENABLED — disable for full hardening')
    else:
        print('[OK] bi_server1 plain HTTP listen port disabled')
except Exception as e:
    print('[UNKNOWN] Cannot read bi_server1 HTTP port state: ' + str(e))

disconnect()
\`\`\`

---

## Script 3: obiee_tls_datasources.conf

\`\`\`
# obiee_tls_datasources.conf — Additional BI data source TCPS endpoints
# Format: hostname|port|label
# One line per Oracle Database instance that BI Server RPD connection pools use.
# These are checked for TCPS port open and TLS 1.2 acceptance.
#
db-server.company.com|1522|Primary BI DataSource DB
dw-server.company.com|1522|Data Warehouse DB
\`\`\`

---

## Deployment

\`\`\`bash
mkdir -p /u01/oracle/scripts /u01/oracle/logs/obiee_tls_verify

cp obiee_tls_verify.sh        /u01/oracle/scripts/
cp obiee_tls_wls_check.py     /u01/oracle/scripts/
cp obiee_tls_datasources.conf /u01/oracle/scripts/

chmod 750 /u01/oracle/scripts/obiee_tls_verify.sh
chmod 640 /u01/oracle/scripts/obiee_tls_wls_check.py
chmod 640 /u01/oracle/scripts/obiee_tls_datasources.conf
chown oracle:oinstall /u01/oracle/scripts/obiee_tls_verify.sh

# Test — verbose, no email
. /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh 2>/dev/null
/u01/oracle/scripts/obiee_tls_verify.sh --verbose --no-email
echo "Exit code: \$?"
\`\`\`

---

## Cron Schedule

\`\`\`bash
# Add to oracle crontab: crontab -e
# Full verification daily at 06:30
30 6 * * * . /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh 2>/dev/null; /u01/oracle/scripts/obiee_tls_verify.sh >> /u01/oracle/logs/obiee_tls_verify/cron.log 2>&1

# Certificate-only check every 4 hours
0 */4 * * * . /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh 2>/dev/null; /u01/oracle/scripts/obiee_tls_verify.sh --certs-only --no-email >> /u01/oracle/logs/obiee_tls_verify/cron_certs.log 2>&1
\`\`\`

---

## Log Rotation

\`\`\`bash
cat > /etc/logrotate.d/obiee-tls-verify << 'EOF'
/u01/oracle/logs/obiee_tls_verify/tls_verify_*.log {
    daily
    rotate 60
    compress
    missingok
    notifempty
}
/u01/oracle/logs/obiee_tls_verify/cron*.log {
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
OBIEE 12c TLS 1.2 Verification — Sun Jun  7 06:30:01 UTC 2026
Host: bi_server1.company.com
Domain: /u01/oracle/config/domains/bi_domain
======================================================

## Layer 1: OHS Inbound TLS

[OK      ] OHS obiee.company.com:443 TLS 1.2 accepted — TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384
[OK      ] OHS obiee.company.com:443 TLS 1.1 correctly rejected
[OK      ] OHS obiee.company.com:443 TLS 1.0 correctly rejected
[OK      ] OHS browser-facing cert valid for 298d (Apr  1 2027)
[OK      ] ssl.conf SSLProtocol includes -ALL +TLSv1.2
[OK      ] ssl.conf uses WebLogicSSLPort (OHS→WLS HTTPS proxy active)
[OK      ] OHS proxy path /analytics → HTTP 302
[OK      ] OHS proxy path /xmlpserver → HTTP 302
[OK      ] OHS proxy path /em → HTTP 302

## Layer 2: WebLogic bi_server1 SSL Listener

[OK      ] WLS bi_server1 bi_server1.company.com:9502 TLS 1.2 accepted — TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384
[OK      ] WLS bi_server1 bi_server1.company.com:9502 TLS 1.1 correctly rejected
[OK      ] WLS bi_server1 bi_server1.company.com:9502 TLS 1.0 correctly rejected
[OK      ] WLS bi_server1 cert valid for 298d
[OK      ] WLS AdminServer cert valid for 298d
[OK      ] WLS identity JKS alias 'obiee-server' valid 298d
[OK      ] bi_server1 HTTP port bi_server1.company.com:9500 closed (plain HTTP disabled)
[OK      ] WLS bi_server1 cipher: ECDHE-RSA-AES256-GCM-SHA384 (forward-secret GCM suite)

## Layer 3: JVM TLS Enforcement Flags

[OK      ] bi_server1 JVM flag 'disabledAlgorithms' active in PID 18432
[OK      ] bi_server1 JVM flag 'javax.net.ssl.trustStore' active in PID 18432
[OK      ] bi_server1 JVM flag 'TLSv1.1 in disabledAlgorithms' active in PID 18432
[OK      ] setDomainEnv.sh -Djdk.tls.disabledAlgorithms present
[OK      ] setDomainEnv.sh -Djavax.net.ssl.trustStore present
[OK      ] setDomainEnv.sh references correct JKS: /u01/oracle/keystores/obiee-trust.jks

## Layer 4: WebLogic TLS Configuration (WLST MBean Read)

[OK      ] bi_server1 SSL listener enabled
[OK      ] bi_server1 MinimumTLSProtocolVersion = TLSv1.2
[OK      ] bi_server1 uses CustomIdentityAndCustomTrust keystores
[OK      ] bi_server1 SSL listen port = 9502
[OK      ] LDAP provider OID_Authenticator port=636 SSL=true (LDAPS)
[OK      ] bi_server1 plain HTTP listen port disabled

## Layer 5: LDAPS Authentication Source

[OK      ] LDAPS oid-server.company.com:636 TLS 1.2 accepted
[OK      ] LDAPS oid-server.company.com:636 TLS 1.1 correctly rejected
[OK      ] OID LDAPS cert valid for 187d
[OK      ] LDAPS anonymous base search succeeded
[OK      ] Trust JKS contains 1 OID/LDAP-related CA alias(es)

## Layer 6: TCPS Database and BI Data Sources

[OK      ] DB TCPS db-server.company.com:1522 TLS 1.2 accepted
[OK      ] DB TCPS cert valid for 201d
[OK      ] DB TCPS port db-server.company.com:1522 open
[OK      ] sqlnet.ora SSL_VERSION = 1.2
[OK      ] sqlnet.ora wallet path exists: /u01/oracle/bi_wallet
[OK      ] DataSource SOADataSource state=Running failedReserves=0
[OK      ] config.xml: all Oracle DataSource URLs appear to use TCPS

## Layer 7: BI Publisher Data Sources

[OK      ] BI Publisher /xmlpserver reachable via OHS → HTTP 302
[OK      ] config.xml: no plain TCP BIP DataSources detected

## Layer 8: Node Manager SSL

[OK      ] nodemanager.properties SecureListener=true
[OK      ] nodemanager.properties references CustomIdentity keystore

## Layer 9: Trust JKS Coverage and Expiry

[OK      ] Trust JKS /u01/oracle/keystores/obiee-trust.jks contains 6 trusted CA entries
[WARNING ] Trust JKS alias 'db-ca' expires in 54d (Jul 31 2026)
[OK      ] setDomainEnv.sh trustStore references: /u01/oracle/keystores/obiee-trust.jks

======================================================
SUMMARY: 30 OK  1 WARNING  0 FAIL/CRITICAL  0 UNKNOWN
Completed: Sun Jun  7 06:30:28 UTC 2026
\`\`\``,
};

async function main() {
  console.log('Inserting OBIEE TLS verification runbook...');
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
