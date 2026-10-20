By Priya Subramaniam

## Problem Statement

An Oracle E-Business Suite 12.2.x environment is running Oracle Developer Forms (ODF) — binary `.fmb`/`.fmx` artifacts — that depend on the Java Plugin for browser delivery. The Java Plugin has been deprecated by all major browsers, requiring Oracle's Forms Standalone Launcher workaround which is operationally fragile. The objective of this runbook is to convert all ODF forms (standard and custom) to XML Forms Definition (XDF) format, compile them using the XDF-aware `frmcmp_batch` compiler, validate functional correctness, and deploy to the EBS middle tier. Upon completion, the Forms runtime operates in browser-native HTML5 mode without the Java Plugin dependency.

**Tech Stack:**
- OS: Oracle Linux 7.9 / RHEL 7.9 (middle tier and DB tier)
- Database: Oracle Database 19c (19.20+)
- EBS Application: Oracle E-Business Suite 12.2.13 or 12.2.14
- Middle Tier: Oracle WebLogic Server 12.2.1.4 / Oracle Forms 12c (12.2.1.9+)
- AD Framework: AD-TXK Delta 13 or later
- Patching: AD Online Patching (adop) cycle

---

## Phase 0: Pre-Migration Assessment

### 0.1 Verify AD-TXK Codelevel

The Forms Migration Assistant (FMA) requires a minimum AD-TXK codelevel. Run the EBS Technology Codelevel Checker (ETCC) to confirm prerequisites are met.

```bash
# Source the EBS environment
source /u01/oracle/EBSapps/EBSapps.env run

# Download and run ETCC
cd $ORACLE_BASE/patches
perl $AD_TOP/bin/admsi.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  check=etcc \
  logfile=/u01/logs/etcc_check.log

cat /u01/logs/etcc_check.log | grep -E "REQUIRED|MISSING|PASS|FAIL"
```

All required patches must show PASS before proceeding. Apply any missing patches via adop before continuing.

### 0.2 Inventory ODF Forms

Generate a complete inventory of `.fmb` files across all product tops. This list defines the migration scope.

```bash
# Count all fmb files by product top
find $APPL_TOP -name "*.fmb" -path "*/forms/US/*" | \
  awk -F'/' '{print $5}' | sort | uniq -c | sort -rn \
  > /u01/logs/fmb_inventory_by_product.txt

cat /u01/logs/fmb_inventory_by_product.txt

# Total count
find $APPL_TOP -name "*.fmb" -path "*/forms/US/*" | wc -l
```

```bash
# Identify custom forms in CUSTOM_TOP
find $CUSTOM_TOP -name "*.fmb" 2>/dev/null | tee /u01/logs/custom_fmb_inventory.txt
wc -l /u01/logs/custom_fmb_inventory.txt
```

### 0.3 Identify HOST() Built-in Usage in Custom Forms

Custom forms that call the `HOST()` built-in are migration blockers — HOST() is security-blocked in browser-mode Forms. Identify them now.

```bash
# HOST() calls in custom fmb files require decompilation first
# Use the FMA analyzer mode to scan without converting
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  fmb_dir=$CUSTOM_TOP/forms/US \
  mode=ANALYZE \
  logfile=/u01/logs/custom_forms_analyze.log

grep -i "HOST\|EXEC_MACRO\|WIN.ACTIVATE" /u01/logs/custom_forms_analyze.log | \
  grep -i "WARNING\|ERROR" \
  > /u01/logs/custom_forms_blockers.txt

echo "Blocker summary:"
wc -l /u01/logs/custom_forms_blockers.txt
```

All HOST() calls must be refactored to concurrent program submissions before migration. Do not proceed until blockers are resolved.

### 0.4 Baseline Performance Metrics

Record current Forms session load metrics before migration. These become the post-migration comparison baseline.

```sql
-- Capture current active Forms session count
SELECT COUNT(*) AS active_forms_sessions,
       TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS captured_at
FROM   v$session
WHERE  module LIKE '%Forms%'
   OR  module LIKE '%frmweb%';

-- Record average Forms page load from FND_LOG (last 7 days)
SELECT ROUND(AVG(elapsed_time)/1000, 2) AS avg_elapsed_ms,
       COUNT(*) AS sample_count
FROM   fnd_log_messages
WHERE  module LIKE '%oracle.apps.fnd.forms%'
  AND  timestamp > SYSDATE - 7;
```

---

## Phase 1: Environment Preparation

### 1.1 Clone Production to Patch Edition

ODF-to-XDF migration is performed inside an adop patch edition. Never convert forms directly in the run edition.

```bash
# Start adop phase=prepare to create patch edition
adop phase=prepare \
  patches=FORMS_XDF_MIGRATION \
  apply_mode=hotpatch \
  logfile=/u01/logs/adop_prepare.log

# Verify patch edition context
cat $CONTEXT_FILE | grep -E "s_file_edition_type|s_patch_edition"
```

### 1.2 Set Up Logging Directory

```bash
mkdir -p /u01/logs/xdf_migration/{standard,custom,compile,deploy}
chmod 755 /u01/logs/xdf_migration

# Timestamp for this migration run
MIGRATION_TS=$(date +%Y%m%d_%H%M%S)
echo "Migration timestamp: $MIGRATION_TS"
```

### 1.3 Backup Current FMX Files

Before overwriting any compiled runtime, snapshot the current middle-tier forms directory.

```bash
BACKUP_DIR=/u01/backup/fmx_backup_${MIGRATION_TS}
mkdir -p $BACKUP_DIR

# Backup run edition fmx files
rsync -av $AU_TOP/forms/US/*.fmx $BACKUP_DIR/standard/ 2>&1 | \
  tee /u01/logs/xdf_migration/fmx_backup.log

rsync -av $CUSTOM_TOP/forms/US/*.fmx $BACKUP_DIR/custom/ 2>/dev/null

echo "Backup complete: $BACKUP_DIR"
du -sh $BACKUP_DIR
```

---

## Phase 2: Standard Oracle Forms Conversion

### 2.1 Convert All Standard Forms — Bulk Mode

Run FMA against each product top in bulk mode. This converts all `.fmb` files in a product directory to `.xdf` XML.

```bash
# Convert AP product forms
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  product_top=$AP_TOP \
  mode=CONVERT_ALL \
  logfile=/u01/logs/xdf_migration/standard/ap_conversion.log

# Convert AR product forms
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  product_top=$AR_TOP \
  mode=CONVERT_ALL \
  logfile=/u01/logs/xdf_migration/standard/ar_conversion.log

# Convert INV product forms
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  product_top=$INV_TOP \
  mode=CONVERT_ALL \
  logfile=/u01/logs/xdf_migration/standard/inv_conversion.log

# Repeat for each product top in scope
# PO, HR, GL, OE, WIP, BOM, etc.
```

### 2.2 Review Conversion Logs

```bash
# Summarize SUCCESS/WARNING/ERROR across all standard conversion logs
for log in /u01/logs/xdf_migration/standard/*.log; do
  echo "=== $(basename $log) ==="
  grep -c "SUCCESS" $log 2>/dev/null && echo " SUCCESS"
  grep -c "WARNING" $log 2>/dev/null && echo " WARNING"
  grep -c "ERROR"   $log 2>/dev/null && echo " ERROR"
done

# Extract all WARNING lines for manual review
grep "WARNING" /u01/logs/xdf_migration/standard/*.log \
  > /u01/logs/xdf_migration/standard/all_warnings.txt

# Extract ERROR lines — these must be resolved before compilation
grep "ERROR" /u01/logs/xdf_migration/standard/*.log \
  > /u01/logs/xdf_migration/standard/all_errors.txt

wc -l /u01/logs/xdf_migration/standard/all_errors.txt
```

Any file listed in `all_errors.txt` must be investigated and manually corrected before proceeding to Phase 3. Common resolutions are documented in Oracle SR or MOS Note 1310225.1.

---

## Phase 3: Custom Forms Conversion and Merge

### 3.1 Convert Custom Forms with FMA

```bash
# Convert custom forms individually
for fmb in $CUSTOM_TOP/forms/US/*.fmb; do
  basename=$(basename $fmb .fmb)
  perl $AD_TOP/bin/adformgen.pl \
    apps_user=apps \
    apps_pwd=<apps_password> \
    fmb_file=$fmb \
    xdf_file=$CUSTOM_TOP/forms/US/${basename}.xdf \
    mode=CONVERT \
    logfile=/u01/logs/xdf_migration/custom/${basename}_conversion.log
  echo "$basename: $(grep -c SUCCESS /u01/logs/xdf_migration/custom/${basename}_conversion.log 2>/dev/null) SUCCESS"
done
```

### 3.2 Three-Way Merge for Customized Standard Forms

For any standard Oracle form that has been customized (copied to CUSTOM_TOP with modifications), perform the three-way merge using `frmxmlconv`. This preserves customizations while rebasing onto the XDF format.

```bash
# Example: Customized AP Invoice Entry form
FORM_NAME=APXINWKB

frmxmlconv \
  base=$AU_TOP/forms/US/${FORM_NAME}_baseline.xdf \
  custom=$CUSTOM_TOP/forms/US/${FORM_NAME}.fmb \
  new=$AU_TOP/forms/US/${FORM_NAME}.xdf \
  output=$CUSTOM_TOP/forms/US/${FORM_NAME}_merged.xdf \
  logfile=/u01/logs/xdf_migration/custom/${FORM_NAME}_merge.log

# Check merge result
grep -E "CONFLICT|MERGE_OK|ERROR" \
  /u01/logs/xdf_migration/custom/${FORM_NAME}_merge.log
```

Any CONFLICT lines in the merge log indicate sections where FMA could not automatically resolve differences between the Oracle baseline and the customization. These require manual XML editing of the merged XDF file. Use an XML-aware editor and validate against the XDF schema after edits.

### 3.3 Validate Merged XDF XML Structure

```bash
# Validate XML well-formedness of all merged XDF files
for xdf in $CUSTOM_TOP/forms/US/*_merged.xdf; do
  xmllint --noout $xdf 2>&1
  if [ $? -eq 0 ]; then
    echo "VALID: $(basename $xdf)"
  else
    echo "INVALID XML: $(basename $xdf) — requires manual correction"
  fi
done
```

---

## Phase 4: Compilation

### 4.1 Compile Standard XDF Forms

```bash
# Set Forms compiler environment
source $ORACLE_HOME/forms/forms_env.sh 2>/dev/null || \
  export PATH=$ORACLE_HOME/bin:$PATH

# Compile standard AP forms
for xdf in $AP_TOP/forms/US/*.xdf; do
  basename=$(basename $xdf .xdf)
  frmcmp_batch \
    module=$xdf \
    userid=apps/<apps_password>@<db_tns_alias> \
    output_file=$AP_TOP/forms/US/${basename}.fmx \
    module_type=FORM \
    compile_all=YES \
    logfile=/u01/logs/xdf_migration/compile/${basename}_compile.log
  status=$?
  if [ $status -ne 0 ]; then
    echo "COMPILE FAILED: $basename (exit $status)"
  else
    echo "COMPILED OK: $basename"
  fi
done
```

```bash
# Summarize compilation results
COMPILED=$(ls /u01/logs/xdf_migration/compile/*_compile.log 2>/dev/null | wc -l)
FAILED=$(grep -l "FRM-" /u01/logs/xdf_migration/compile/*.log 2>/dev/null | wc -l)
echo "Compiled: $COMPILED | Failed: $FAILED"

# Show all FRM- compiler errors
grep "FRM-" /u01/logs/xdf_migration/compile/*.log | head -40
```

### 4.2 Compile Custom XDF Forms

```bash
for xdf in $CUSTOM_TOP/forms/US/*.xdf; do
  basename=$(basename $xdf .xdf)
  frmcmp_batch \
    module=$xdf \
    userid=apps/<apps_password>@<db_tns_alias> \
    output_file=$CUSTOM_TOP/forms/US/${basename}.fmx \
    module_type=FORM \
    compile_all=YES \
    logfile=/u01/logs/xdf_migration/compile/custom_${basename}_compile.log
  echo "$basename: exit $?"
done
```

### 4.3 Common Compiler Errors and Resolutions

**FRM-30053: Cannot find object** — a referenced object library or PL/SQL library cannot be found. Verify `$AU_TOP/resource` is on the compiler's module path:

```bash
frmcmp_batch \
  module=$xdf \
  userid=apps/<password>@<db> \
  output_file=<fmx> \
  module_type=FORM \
  compile_all=YES \
  module_access_path=$AU_TOP/resource:$CUSTOM_TOP/resource
```

**FRM-10102: Cannot open file** — the XDF file path has a space or special character. Wrap the module argument in quotes and verify the file exists.

**FRM-40735: Trigger raised unhandled exception** — a PL/SQL trigger contains a construct invalid in Forms 12c. Review the trigger body in the XDF XML (search for the FRM-40735 trigger name), correct the PL/SQL, and recompile.

---

## Phase 5: Middle-Tier Deployment

### 5.1 Copy Compiled FMX to Run Edition

```bash
# Copy standard product FMX files to AU_TOP run edition
# (adop manages edition context; deploy within patch edition)
for product_top in $AP_TOP $AR_TOP $INV_TOP $PO_TOP $HR_TOP $GL_TOP; do
  cp -v ${product_top}/forms/US/*.fmx $AU_TOP/forms/US/ 2>/dev/null
done

# Copy custom FMX files
cp -v $CUSTOM_TOP/forms/US/*.fmx $CUSTOM_TOP/forms/US/ 2>/dev/null
```

### 5.2 Update formsweb.cfg for XDF Mode

Verify the Forms servlet configuration enables the HTML5 client (not the Java Applet client):

```bash
FORMSWEB_CFG=$FND_TOP/secure/<context_name>/formsweb.cfg

# Check current client setting
grep -E "jinitiator|webutil|lookAndFeel|clientDeploy" $FORMSWEB_CFG

# The XDF/HTML5 mode requires:
grep "lookAndFeel=oracle" $FORMSWEB_CFG || \
  echo "WARNING: lookAndFeel not set to oracle — XDF HTML5 mode may not activate"
```

If the `lookAndFeel` parameter is not set to `oracle`, update `formsweb.cfg` and run AutoConfig:

```bash
# Update in context file via OAM or directly:
# Set s_formsweb_lookandfeel=oracle in context XML, then:
perl $AD_TOP/bin/adconfig.pl \
  contextfile=$CONTEXT_FILE \
  run=all \
  logfile=/u01/logs/xdf_migration/autoconfig.log
```

### 5.3 Bounce the Forms Managed Server

```bash
# Connect via WLST and restart the Forms managed server
$FMW_HOME/oracle_common/common/bin/wlst.sh << 'WLST_EOF'
connect('weblogic','<wls_admin_password>','t3://<wls_admin_host>:7001')
domainRuntime()

# Graceful shutdown — wait for active sessions to complete
shutdown('FormsServer_1', 'Server', ignoreSessions=False, timeout=300)
start('FormsServer_1', 'Server')

# Verify state
state('FormsServer_1', 'Server')
disconnect()
exit()
WLST_EOF
```

Confirm the managed server reaches RUNNING state before proceeding.

---

## Phase 6: Functional Regression Testing

### 6.1 Smoke Test Checklist

For each converted form, execute this minimum smoke test before sign-off. Use a dedicated test responsibility with no production data risk.

```bash
# Generate test checklist from converted forms list
for fmx in $AU_TOP/forms/US/*.fmx; do
  form_name=$(basename $fmx .fmx)
  echo "[ ] $form_name — open | query | insert/update | close"
done > /u01/logs/xdf_migration/smoke_test_checklist.txt

wc -l /u01/logs/xdf_migration/smoke_test_checklist.txt
```

Critical path forms to prioritize (minimum viable regression set):

- **APXINWKB** — AP Invoice Workbench (high transaction volume, complex LOV logic)
- **ARXRWMAI** — AR Receipts (multi-block, flex fields)
- **POXPOEPO** — PO Entry (workflow integration, status triggers)
- **INVTTEAM** — INV Item Master (descriptive flexfields, category sets)
- **HRFASASM** — HR Assignment (date-tracked, approval workflow)
- **GLXJEENT** — GL Journal Entry (multi-currency, balancing triggers)

### 6.2 Flexfield Validation Script

Run this SQL after testing flexfield entry on converted forms to confirm WHO column population and flexfield validation are working correctly:

```sql
-- Verify WHO columns populated correctly post-XDF (AP invoices)
SELECT ai.invoice_id,
       ai.invoice_num,
       ai.created_by,
       fu_created.user_name     AS created_by_user,
       ai.last_updated_by,
       fu_updated.user_name     AS updated_by_user,
       ai.last_update_date
FROM   ap_invoices_all    ai
JOIN   fnd_user           fu_created ON fu_created.user_id = ai.created_by
JOIN   fnd_user           fu_updated ON fu_updated.user_id = ai.last_updated_by
WHERE  ai.last_update_date > SYSDATE - 1/24
ORDER  BY ai.last_update_date DESC
FETCH  FIRST 10 ROWS ONLY;

-- Confirm descriptive flexfield segments saved correctly (using AP as example)
SELECT ai.invoice_id,
       ai.attribute1,
       ai.attribute2,
       ai.attribute_category
FROM   ap_invoices_all ai
WHERE  ai.last_update_date > SYSDATE - 1/24
  AND  ai.attribute1 IS NOT NULL;
```

### 6.3 Verify Concurrent Program Submissions from Forms

Any form that submits a concurrent request must be tested end-to-end:

```sql
-- Check concurrent requests submitted via converted forms in last hour
SELECT cr.request_id,
       cp.user_concurrent_program_name,
       cr.requested_by,
       fu.user_name,
       cr.phase_code,
       cr.status_code,
       cr.actual_start_date,
       cr.actual_completion_date
FROM   fnd_concurrent_requests cr
JOIN   fnd_concurrent_programs_vl cp
       ON cp.concurrent_program_id = cr.concurrent_program_id
JOIN   fnd_user fu ON fu.user_id = cr.requested_by
WHERE  cr.request_date > SYSDATE - 1/24
ORDER  BY cr.request_id DESC;
```

Phase_code = 'C' (Complete) and Status_code = 'N' (Normal) confirms the submit cycle from the XDF form worked correctly.

---

## Phase 7: adop Finalize and Cutover

### 7.1 Run adop Finalize

Once functional testing passes in the patch edition, finalize the adop cycle to promote XDF forms to the run edition.

```bash
adop phase=finalize \
  logfile=/u01/logs/xdf_migration/adop_finalize.log

# Monitor progress
tail -f /u01/logs/xdf_migration/adop_finalize.log
```

### 7.2 Cutover

```bash
adop phase=cutover \
  logfile=/u01/logs/xdf_migration/adop_cutover.log
```

After cutover, the XDF-compiled `.fmx` files are live in the run edition. The Forms servlet serves them in HTML5 browser mode.

### 7.3 Post-Cutover Verification

```bash
# Confirm Forms servlet is responding in XDF mode
curl -s -o /dev/null -w "%{http_code}" \
  "http://<ebs_host>:<port>/forms/frmservlet?config=<config_name>"

# Check WebLogic Forms server logs for XDF mode confirmation
grep -i "xdf\|html5\|browser" \
  $FMW_HOME/user_projects/domains/<domain>/servers/FormsServer_1/logs/FormsServer_1.log | \
  tail -20
```

---

## Phase 8: Rollback Procedure

If critical issues are discovered post-cutover that cannot be resolved within the maintenance window, restore from the FMX backup taken in Phase 1.3.

```bash
# Stop Forms managed server
$FMW_HOME/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://<host>:7001')
domainRuntime()
shutdown('FormsServer_1','Server')
disconnect()
exit()
EOF

# Restore standard FMX files from backup
rsync -av $BACKUP_DIR/standard/ $AU_TOP/forms/US/

# Restore custom FMX files
rsync -av $BACKUP_DIR/custom/ $CUSTOM_TOP/forms/US/

# Restart Forms managed server
$FMW_HOME/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://<host>:7001')
domainRuntime()
start('FormsServer_1','Server')
state('FormsServer_1','Server')
disconnect()
exit()
EOF

echo "Rollback complete. Verify Forms login in browser."
```

If the adop cutover has already been committed, raise an Oracle SR immediately. A post-cutover Forms regression requires an emergency patch or targeted form re-deployment via adop hotpatch.

---

## Summary

- **Phase 0**: ETCC prerequisite check, ODF inventory, HOST() blocker identification, baseline metrics.
- **Phase 1**: adop patch edition, logging setup, FMX backup.
- **Phase 2**: Bulk FMA conversion of all standard product forms; error review.
- **Phase 3**: Custom form FMA conversion; three-way `frmxmlconv` merge for customized standard forms; XML validation.
- **Phase 4**: `frmcmp_batch` compilation of all XDF files; FRM- error resolution.
- **Phase 5**: FMX deployment to middle tier; `formsweb.cfg` XDF mode validation; Forms managed server bounce.
- **Phase 6**: Smoke test checklist; flexfield WHO column SQL validation; concurrent program submission verification.
- **Phase 7**: adop finalize and cutover; post-cutover verification.
- **Phase 8**: Rollback via FMX backup restore if critical regression discovered.

## References

- [Oracle Forms Migration Assistant Guide (MOS Note 1310225.1)](https://support.oracle.com/epmos/faces/DocumentDisplay?id=1310225.1)
- [Oracle E-Business Suite Release 12.2 Maintenance Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22954/toc.htm)
- [Oracle Forms Developer Guide 12c](https://docs.oracle.com/middleware/12213/forms/develop-forms/index.html)
- [Oracle E-Business Suite AD Utilities Reference Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22950/toc.htm)
- [Oracle E-Business Suite Technology Stack Administration Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22956/toc.htm)
- [Oracle WebLogic Server 12.2.1 Administration Guide](https://docs.oracle.com/middleware/12213/wls/ADMRF/index.html)
