import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const MARKER = '## Version-Specific Notes';

interface VC { description: string; steps: string[]; }
interface VS { v11i: VC; v1213: VC; v122: VC; }

function buildSection(vs: VS): string {
  const fmt = (vc: VC) =>
    `**Description:** ${vc.description}\n\n**Action plan:**\n${vc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  return `\n\n---\n\n## Version-Specific Notes\n\n### EBS 11i (Release 11.5.x)\n\n${fmt(vs.v11i)}\n\n### EBS 12.1.3\n\n${fmt(vs.v1213)}\n\n### EBS 12.2.x\n\n${fmt(vs.v122)}`;
}

// ── Cluster definitions ────────────────────────────────────────────────────

const ADOP_ONLY = buildSection({
  v11i: {
    description: 'EBS 11i uses adpatch for all patching. There is no dual filesystem, no patch edition, and no adop lifecycle. The concepts in this article are not applicable to 11i.',
    steps: [
      'Use adpatch to apply patches. Take the application tier down before patching (cold patch required).',
      'Monitor workers with adctrl. Check ad_deferred_jobs for failed workers.',
      'Review $APPL_TOP/admin/<SID>/log/ for adpatch worker logs.',
      'After patching, run autoconfig and bounce all services to activate changes.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 uses adpatch with a single APPL_TOP. Online patching via adop is not available. The dual filesystem and edition concepts described here do not apply.',
    steps: [
      'Use adpatch to apply patches. Schedule a downtime window for all but the smallest patches.',
      'Use adctrl to monitor and restart failed workers.',
      'After patching, run autoconfig ($AD_TOP/bin/adautocfg.sh) and restart services.',
      'Check $INST_TOP/logs/appl/rgf/FNDLIBR for concurrent manager post-patch verification.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x uses adop for online patching with a dual filesystem (run/patch editions). This article applies directly to 12.2 environments.',
    steps: [
      'Run adop phase=prepare to clone the run filesystem to the patch edition.',
      'Apply patches on the patch filesystem with adop phase=apply.',
      'Run adop phase=finalize, then phase=cutover to promote the patch edition to run.',
      'Use adop phase=cleanup to reclaim space. Monitor AD_PM_WORKERS and AD_ADOP_SESSIONS for status.',
    ],
  },
});

const PATCHING_GENERAL = buildSection({
  v11i: {
    description: 'EBS 11i patching uses adpatch exclusively. All patches require application tier downtime. Worker management is done through adctrl and the AD_DEFERRED_JOBS table.',
    steps: [
      'Download patch from My Oracle Support. Unzip and read README.txt for prerequisites.',
      'Set environment: source $APPL_TOP/APPSORA.env (or appsora.env).',
      'Run adpatch: cd $APPL_TOP/admin/<SID>; adpatch logfile=patch_<number>.log.',
      'Monitor workers with adctrl (option 4 = show workers). Restart failed workers from adctrl option 2.',
      'After patching, run autoconfig and bounce Apache, Forms, and Concurrent Manager.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 patching uses adpatch against a single APPL_TOP. Most patches require downtime. AutoConfig uses context.xml for configuration management.',
    steps: [
      'Source environment: . $APPL_TOP/EBSapps.env (or equivalent for your install).',
      'Run adpatch from $APPL_TOP/admin/$TWO_TASK/: adpatch logfile=patch_<number>.log.',
      'Monitor with adctrl. Check $APPL_TOP/admin/$TWO_TASK/log/ for worker logs.',
      'Run autoconfig after patching: $AD_TOP/bin/adautocfg.sh.',
      'Bounce OHS, OC4J, and Concurrent Manager to activate changes.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x uses adop for online patching. Most patches can be applied without taking the application offline. The dual filesystem isolates patch activity from the live run edition.',
    steps: [
      'Source run edition environment: . $EBS_DOMAIN_HOME/EBSapps.env run.',
      'Run adop phase=prepare to initialize the patch edition.',
      'Apply patch: adop phase=apply patches=<number>.',
      'Run adop phase=finalize then adop phase=cutover (brief downtime at cutover).',
      'Run adop phase=cleanup. Monitor AD_PM_WORKERS for worker failures during apply.',
    ],
  },
});

const CONCURRENT_MANAGER = buildSection({
  v11i: {
    description: 'In EBS 11i the Concurrent Manager runs as a set of FNDCP OS processes under a single APPL_TOP. Configuration is stored in FND_CONCURRENT_QUEUES. There is no WebLogic or OC4J dependency.',
    steps: [
      'Start/stop CM via: FNDLIBR FNDCPMBR STARTMGR/STOPMGR or through the System Administrator responsibility.',
      'Check ICM status: SELECT * FROM fnd_concurrent_queues WHERE manager_type = \'ConcurrentManager\';',
      'For stuck requests, query FND_CONCURRENT_REQUESTS and kill the OS process (find PID via OS_PROCESS_ID column).',
      'Purge old metadata with FNDCPPUR concurrent program. Schedule weekly for high-volume environments.',
      'Check $APPL_TOP/admin/<SID>/log/FNDLIBR* logs for ICM startup failures.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 Concurrent Manager runs under the 10.1.3 OC4J application tier. Core CM behavior is identical to 11i but the process stack and environment sourcing differ.',
    steps: [
      'Source environment: . $INST_TOP/ora/10.1.2/EBSapps.env.',
      'Start/stop CM via $ADMIN_SCRIPTS_HOME/adcmctl.sh start|stop apps/<password>.',
      'Check ICM and service manager status in OAM (Oracle Application Manager) or via FND_CONCURRENT_QUEUES.',
      'Kill zombie sessions: identify OS_PROCESS_ID in FND_CONCURRENT_REQUESTS, then kill -9 <pid>.',
      'Purge metadata with FNDCPPUR. Review $INST_TOP/logs/appl/rgf/ for ICM logs.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x Concurrent Manager runs on the run edition application tier under WebLogic. CM processes are edition-aware and must operate against the run edition ORACLE_HOME.',
    steps: [
      'Source run edition: . $EBS_DOMAIN_HOME/EBSapps.env run.',
      'Start/stop CM: $ADMIN_SCRIPTS_HOME/adcmctl.sh start|stop apps/<password>.',
      'Monitor workers via AD_PM_WORKERS during adop. Check FND_CONCURRENT_REQUESTS for stuck requests.',
      'For RAC environments, use DBMS_SCHEDULER services to pin CM to a specific instance: CREATE SERVICE ... PREFERRED_INSTANCES.',
      'Purge metadata with FNDCPPUR; monitor FND_CONCURRENT_REQUESTS row count against AUTO_RESUBMIT thresholds.',
    ],
  },
});

const TLS_SSL = buildSection({
  v11i: {
    description: 'EBS 11i uses Oracle HTTP Server (Apache-based) with mod_ssl. SSL is terminated at OHS. Oracle Wallet stores the server certificate. There is no WebLogic tier.',
    steps: [
      'Place certificate in Oracle Wallet using orapki: orapki wallet add -wallet $ORACLE_HOME/wallets/server -trusted_cert -cert ca.cer.',
      'Add server certificate: orapki wallet add -wallet $ORACLE_HOME/wallets/server -user_cert -cert server.cer.',
      'Configure $ORACLE_HOME/Apache/Apache/conf/ssl.conf with SSLWallet and SSLWalletPassword.',
      'Run AutoConfig to regenerate SSL config: $AD_TOP/bin/adautocfg.sh.',
      'Bounce Apache: $ADMIN_SCRIPTS_HOME/adapcctl.sh stop && adapcctl.sh start.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 uses OHS with OC4J. SSL is terminated at OHS. The application tier uses the 10.1.3 OC4J server for Java components. Wallet management is identical to 11i at the OHS layer.',
    steps: [
      'Manage OHS wallet with orapki at $INST_TOP/ora/10.1.2/sysman/config/monwallet or per ohs.conf.',
      'Add certificates to wallet: orapki wallet add -wallet <wallet_path> -trusted_cert -cert ca.cer.',
      'Configure $INST_TOP/ora/10.1.2/Apache/Apache/conf/ssl.conf for wallet path and password.',
      'Run AutoConfig to push SSL config: $AD_TOP/bin/adautocfg.sh.',
      'Restart OHS: $ADMIN_SCRIPTS_HOME/adapcctl.sh stop && adapcctl.sh start.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x has two SSL layers: OHS (Oracle Wallet) and WebLogic (Java KeyStore or PKCS12). AutoConfig manages both. Certificate changes must be applied to both tiers and AutoConfig must be run on both run and patch editions.',
    steps: [
      'Import certificate into OHS wallet: orapki wallet add -wallet $INST_TOP/ora/10.1.2/sysman/config/monwallet -trusted_cert -cert ca.cer.',
      'Import into WebLogic trust store: keytool -importcert -keystore $WL_HOME/server/lib/DemoTrust.jks -alias <alias> -file ca.cer.',
      'Update context file parameters for wallet paths using txkSetContextParam.pl to survive AutoConfig.',
      'Run AutoConfig on run edition, then patch edition: adautocfg.sh (once per edition).',
      'Restart OHS and WebLogic: $ADMIN_SCRIPTS_HOME/adapcctl.sh restart; $ADMIN_SCRIPTS_HOME/adadminsrvctl.sh restart.',
    ],
  },
});

const CODE_SIGNING = buildSection({
  v11i: {
    description: 'EBS 11i Java applets are delivered as signed JARs but the signing mechanism predates adkeystore.dat. Custom JAR signing uses a standard JKS keystore with jarsigner. No adkeystore.dat management is required.',
    steps: [
      'Generate or obtain a code-signing certificate and import into a JKS keystore.',
      'Sign custom JARs: jarsigner -keystore <keystore.jks> -storepass <pass> custom.jar <alias>.',
      'Deploy signed JARs to $JAVA_TOP or $APPL_TOP/java.',
      'Verify signature: jarsigner -verify -verbose custom.jar.',
      'Bounce Apache to serve the updated JAR to client browsers.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 requires signed JARs for browser delivery. The signing process uses a JKS keystore and jarsigner. Certificate trust is managed by client JRE trust anchors, not adkeystore.dat.',
    steps: [
      'Obtain a code-signing certificate from a trusted CA or self-signed for internal use.',
      'Sign JARs: jarsigner -keystore <keystore.jks> -storepass <pass> custom.jar <alias>.',
      'Copy signed JARs to $OA_HTML/java or $JAVA_TOP as appropriate.',
      'Clear Forms/Java cache: delete $INST_TOP/ora/10.1.2/.jcache on the mid-tier.',
      'Verify client browsers trust the signing CA before deploying to production.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x mandates code signing for all custom JARs through adkeystore.dat. The EBS Technology Manager (adkeystore) manages the keystore and signing pipeline. This is enforced by WebLogic\'s classloader and cannot be bypassed.',
    steps: [
      'Generate keystore entry: adkeystore -action genkey -alias <alias> -keyAlg RSA -keySize 2048.',
      'Export CSR and obtain certificate from CA, or use self-signed for non-browser delivery.',
      'Import signed certificate: adkeystore -action importcert -alias <alias> -file server.cer.',
      'Sign JARs using adkeystore: adkeystore -action sign -jarfile custom.jar -alias <alias>.',
      'Deploy signed JARs and clear $INST_TOP/ora/10.1.2/.jcache. Run AutoConfig to refresh WebLogic config.',
    ],
  },
});

const FILESYSTEM_ARCH = buildSection({
  v11i: {
    description: 'EBS 11i uses a single APPL_TOP directory structure with one set of environment files. There is no dual filesystem, no edition concept, and no fs1/fs2/fs_ne separation.',
    steps: [
      'APPL_TOP contains all application-tier files. Source environment with $APPL_TOP/APPSORA.env.',
      'ORACLE_HOME contains the database and/or application tier Oracle binaries.',
      'Changes to application files take effect immediately — no edition promotion step.',
      'Customizations are placed under $APPL_TOP/<CUSTOM_TOP> following Oracle Custom Top guidelines.',
      'AutoConfig regenerates configuration files from $APPL_TOP/admin/<SID>/out/. Protect custom files from overwrite.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 introduces the INST_TOP concept, separating instance-specific configuration from the shared APPL_TOP. Still a single filesystem with no dual-edition structure.',
    steps: [
      'APPL_TOP contains shared application files. INST_TOP contains instance-specific config and logs.',
      'Source environment: . $INST_TOP/ora/10.1.2/EBSapps.env.',
      'AutoConfig populates $INST_TOP/ora/10.1.2/Apache/Apache/conf/ and $INST_TOP/logs/.',
      'Custom tops go under $APPL_TOP/<CUSTOM_TOP>. Map them in the context file via custom_top context variable.',
      'Configuration changes take effect after AutoConfig + service bounce. No edition concept.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x uses a dual filesystem: fs1 and fs2 (run and patch editions) plus fs_ne (non-editioned). The active run edition serves traffic; the patch edition is used during adop apply. After cutover the roles swap.',
    steps: [
      'Identify run and patch editions: cat $EBS_DOMAIN_HOME/fs_info.cfg.',
      'Source run environment: . $EBS_DOMAIN_HOME/EBSapps.env run.',
      'Source patch environment: . $EBS_DOMAIN_HOME/EBSapps.env patch (only during adop lifecycle).',
      'fs_ne (non-editioned) contains shared files not subject to edition management (e.g., certain jar caches).',
      'After adop phase=cutover, run and patch roles swap. Always source the correct edition before working.',
    ],
  },
});

const SOA_WEBLOGIC = buildSection({
  v11i: {
    description: 'EBS 11i does not have the Integrated SOA Gateway or WebLogic. Workflow uses Oracle Advanced Queuing directly. Web service integrations in 11i required third-party middleware or custom PL/SQL over HTTP.',
    steps: [
      'For outbound HTTP integrations, use UTL_HTTP from PL/SQL with proper ACL grants (Oracle 11g+) or UTL_FILE for file-based.',
      'Workflow notifications use Oracle AQ. Check AQ queue status with DBMS_AQADM procedures.',
      'Custom web service consumers require Java concurrent programs using standard JDBC/HTTP libraries.',
      'No ISG or SOA-specific configuration applies to 11i environments.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 introduced the Integrated SOA Gateway on OC4J. B2B capabilities and SOA Suite integration are available but limited compared to 12.2. ISG runs under the 10.1.3 OC4J container.',
    steps: [
      'Check ISG deployment: $FND_TOP/bin/FNDSVCRG for service registry status.',
      'ISG services run under OC4J: verify via opmnctl status.',
      'For B2B integrations, check the ISG repository via FND_SOA_SERVICE_REGISTRY.',
      'Deploy ISG interfaces via the Integration Repository in OAM.',
      'Restart ISG: opmnctl stopall && opmnctl startall (bounces all OC4J components).',
    ],
  },
  v122: {
    description: 'EBS 12.2.x runs ISG on WebLogic 12c with full SOA Suite integration. B2B-50079 and other transport errors are specific to the WebLogic-based ISG tier. The managed server ebs_soainfra hosts SOA components.',
    steps: [
      'Check ISG/SOA managed server status: $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status ebs_soainfra.',
      'Review SOA composite deployment status in EM Fusion Middleware Control.',
      'For B2B-50079 transport errors, check WebLogic JMS queues and connection factories in the WL Admin Console.',
      'Restart ISG: admanagedsrvctl.sh stop ebs_soainfra && admanagedsrvctl.sh start ebs_soainfra.',
      'After AutoConfig, re-seed ISG if configuration templates changed: FNDLOAD for ISG metadata.',
    ],
  },
});

const TNS_JDBC = buildSection({
  v11i: {
    description: 'EBS 11i uses a single $TNS_ADMIN (typically $ORACLE_HOME/network/admin) for tnsnames.ora. AutoConfig regenerates this file from the context XML. Custom descriptors must be preserved via context file customization or post-AutoConfig hooks.',
    steps: [
      'Identify $TNS_ADMIN: echo $TNS_ADMIN (default: $ORACLE_HOME/network/admin).',
      'Back up custom TNS entries before any AutoConfig run.',
      'Add custom descriptors to the AutoConfig template: $APPL_TOP/admin/<SID>/out/tnsnames.ora.tmpl.',
      'Run autoconfig: $AD_TOP/bin/adautocfg.sh. Verify custom entries survived in generated tnsnames.ora.',
      'Test connectivity: tnsping <custom_service>.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 has multiple ORACLE_HOMEs (Database, 10.1.2, 10.1.3 for app tier). Each may have its own tnsnames.ora. Custom entries must be preserved in all relevant homes. AutoConfig regenerates all of them.',
    steps: [
      'Identify all tnsnames.ora locations: find $APPL_TOP $ORACLE_HOME $INST_TOP -name tnsnames.ora.',
      'Back up all tnsnames.ora files before AutoConfig.',
      'Add custom entries to the appropriate context file template under $APPL_TOP/admin/<SID>/.',
      'Run AutoConfig and verify all tnsnames.ora files contain the custom entries.',
      'Test: tnsping <custom_service> from each relevant ORACLE_HOME environment.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x has multiple ORACLE_HOMEs across run and patch editions. AutoConfig runs on both editions and regenerates tnsnames.ora in each. Use txkSetContextParam.pl for AutoConfig-safe changes to avoid edition drift.',
    steps: [
      'List all tnsnames.ora paths for run edition: . $EBS_DOMAIN_HOME/EBSapps.env run; find $ORACLE_HOME $INST_TOP -name tnsnames.ora.',
      'Use txkSetContextParam.pl to register custom parameter values in the context file so they survive AutoConfig.',
      'Alternatively, use a post-AutoConfig hook ($AD_TOP/custom/) to append custom entries after each AutoConfig run.',
      'Run AutoConfig on run edition, then patch edition, verifying custom entries in both.',
      'Test connectivity from both run and patch edition environments.',
    ],
  },
});

const FORMS = buildSection({
  v11i: {
    description: 'EBS 11i uses Oracle Forms 6i. The Forms runtime environment is configured in $ORACLE_HOME/forms60/server/default.env. Client access uses JInitiator (Oracle\'s JRE plugin). Modern browsers do not support Forms 6i without legacy configurations.',
    steps: [
      'Configure Forms environment in $ORACLE_HOME/forms60/server/default.env.',
      'Enable crash trace: add FORMS_CATCHTERM=1 to default.env (no bounce required for new sessions).',
      'Trace files write to FORMS_TRACE_DIR. Set in default.env: FORMS_TRACE_DIR=<path>.',
      'For ORA-01001 Invalid Cursor errors, check FND_SESSIONS purge job and database cursor limits (OPEN_CURSORS parameter).',
      'Client setup: Install JInitiator from $OA_HTML/jre/jinit.exe. Verify applet tag in forms.htm.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 uses Oracle Forms 10g running under OC4J. Environment is configured in $INST_TOP/ora/10.1.2/forms/server/default.env. Client access uses Sun JRE (not JInitiator).',
    steps: [
      'Configure Forms environment in $INST_TOP/ora/10.1.2/forms/server/default.env.',
      'Enable crash trace: add FORMS_CATCHTERM=1. Trace dir: FORMS_TRACE_DIR=$INST_TOP/logs/forms.',
      'For cursor errors, check OPEN_CURSORS in the database and FND_SESSIONS (should match open sessions).',
      'Restart Forms: opmnctl restartproc ias-component=forms (restarts OC4J Forms component).',
      'Client: Install Sun JRE 6u<n>. Configure browser Java plugin for EBS forms URL.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x uses Oracle Forms 10g on WebLogic. There are two INST_TOPs (run and patch editions), each with their own default.env. Forms runs as a WebLogic managed server. Changes to default.env must be applied to the active run edition.',
    steps: [
      'Identify run edition INST_TOP: . $EBS_DOMAIN_HOME/EBSapps.env run; echo $INST_TOP.',
      'Configure Forms in $INST_TOP/ora/10.1.2/forms/server/default.env.',
      'Enable crash trace: FORMS_CATCHTERM=1 in default.env. Trace dir: FORMS_TRACE_DIR=$INST_TOP/logs/forms.',
      'Restart Forms managed server: $ADMIN_SCRIPTS_HOME/adformsrvctl.sh stop && adformsrvctl.sh start.',
      'After adop cutover, apply same changes to the new run edition\'s default.env.',
    ],
  },
});

const LDAP = buildSection({
  v11i: {
    description: 'EBS 11i uses Oracle Internet Directory (OID) 9i or 10g with Oracle Single Sign-On (OSSO). The integration relies on the Oracle SSO infrastructure and OID LDAP protocol. FND_LDAP_WRAPPER is available in later 11i releases.',
    steps: [
      'Check OID connectivity: ldapsearch -h <oid_host> -p 389 -D "cn=orcladmin" -w <pass> -b "" -s base objectclass=*.',
      'Verify OSSO registration: check $ORACLE_HOME/SSO/conf/osso.conf for partner app registration.',
      'Test FND_LDAP_WRAPPER (if available): exec fnd_ldap_wrapper.verify_user(\'<user>\', \'<pass>\');',
      'Check LDAP profile options: FND_LDAP_ADMIN_USERNAME, FND_LDAP_HOST, FND_LDAP_PORT in System Administration.',
      'Review $ORACLE_HOME/ldap/log/ for OID server errors and connection issues.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 uses OID 10g or 11g with OSSO or Oracle Access Manager (OAM). FND_LDAP_WRAPPER and DBMS_LDAP are the primary integration points. OID runs as a separate component from the EBS application tier.',
    steps: [
      'Verify OID status: opmnctl status (on the OID host) or check OAM admin console.',
      'Test LDAP bind from EBS DB: exec dbms_ldap.open_ssl(\'<oid_host>\', 389, ...); (requires DBMS_LDAP grant).',
      'Check FND_USER_PREFERENCES and HR_OPERATING_UNITS for LDAP user sync issues.',
      'Run FNDSCARU (Synchronize User Accounts) concurrent program to re-sync with LDAP.',
      'Review $INST_TOP/logs/appl/rgf/FNDLIBR* for LDAP-related concurrent program failures.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x supports OID or Oracle Unified Directory (OUD) with OAM. In addition to FND LDAP integration, WebLogic uses Oracle Platform Security Services (OPSS) with its own LDAP connection. Both stacks must be healthy for authentication to work end-to-end.',
    steps: [
      'Check FND LDAP: FND profile options FND_LDAP_HOST, FND_LDAP_PORT, FND_LDAP_BASE via System Administration.',
      'Check WebLogic OPSS LDAP: WL Admin Console → Security Realms → myrealm → Providers → verify OID/OUD connection.',
      'Test OPSS LDAP connectivity from WebLogic: use WLST or JMX to validate authentication provider status.',
      'Run FNDSCARU (User Sync) concurrent program for FND-level LDAP sync.',
      'Review $DOMAIN_HOME/servers/AdminServer/logs/ for OPSS authentication provider errors.',
    ],
  },
});

const INSTALL_CLONE = buildSection({
  v11i: {
    description: 'EBS 11i cloning uses adpreclone.pl and adcfgclone.pl against a single APPL_TOP and ORACLE_HOME. The context file concept was not yet introduced; configuration is driven by environment variables and adconfig.txt.',
    steps: [
      'On source: perl $APPL_TOP/admin/adpreclone.pl appsTier (and dbTier separately).',
      'Copy APPL_TOP and ORACLE_HOME to target system (cold copy or RMAN for DB).',
      'On target: perl $APPL_TOP/admin/adcfgclone.pl appsTier (provide target hostnames and SID when prompted).',
      'Run autoconfig to regenerate all config files for the new hostname.',
      'Start services and verify with tnsping and forms/reports access.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 cloning uses adpreclone.pl and adcfgclone.pl with the context.xml file introduced to manage configuration parameters. Multiple ORACLE_HOMEs (DB, 10.1.2, 10.1.3) must all be cloned.',
    steps: [
      'On source, run adpreclone.pl for each tier: perl $AD_TOP/bin/adpreclone.pl dbTier and appsTier.',
      'Copy ORACLE_HOME (10.1.2 and 10.1.3), APPL_TOP, and INST_TOP to the target.',
      'For DB clone: use RMAN duplicate or cold copy. Run nid to change DBID if required.',
      'On target, run adcfgclone.pl: perl $AD_TOP/bin/adcfgclone.pl appsTier (provide target context parameters).',
      'Run autoconfig and verify all services start cleanly on target host.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x cloning handles the dual filesystem (run and patch editions) and supports PDB cloning for the database tier. adpreclone and adcfgclone are edition-aware. The clone process clones both editions.',
    steps: [
      'Source run environment: . $EBS_DOMAIN_HOME/EBSapps.env run.',
      'Run adpreclone for DB: perl $ORACLE_HOME/appsutil/scripts/<context>/adpreclone.pl dbTier.',
      'Run adpreclone for app tier: perl $AD_TOP/bin/adpreclone.pl appsTier.',
      'For DB: use RMAN active duplication or PDB clone (noncdb_to_pdb for non-CDB → PDB migration).',
      'On target: perl $AD_TOP/bin/adcfgclone.pl appsTier. Provide new hostname, port, and SID. Run autoconfig.',
    ],
  },
});

const HA_DR = buildSection({
  v11i: {
    description: 'EBS 11i Data Guard and HA configurations involve manual switchover procedures. There is no adop edition awareness to handle during switchover. RMAN catalog must be resynced manually after standby role change.',
    steps: [
      'Verify primary/standby status: SELECT DATABASE_ROLE, OPEN_MODE FROM V$DATABASE;',
      'Manual switchover: ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY; on primary.',
      'Activate standby: ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY; on former standby.',
      'After switchover, update EBS application tier tnsnames.ora to point to new primary.',
      'Resync RMAN catalog: RMAN TARGET / CATALOG <rman_user>/<pass>@<catalog>; RESYNC CATALOG;',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 Data Guard uses standard Oracle Physical Standby. Switchover procedure is similar to 11i. Application tier reconfiguration is required after primary role change. RMAN catalog resync with the new primary is essential.',
    steps: [
      'Confirm standby is in sync: SELECT SEQUENCE#, APPLIED FROM V$ARCHIVED_LOG ORDER BY SEQUENCE# DESC;',
      'Switchover: ALTER DATABASE COMMIT TO SWITCHOVER TO PHYSICAL STANDBY; (primary), then RECOVER MANAGED STANDBY DATABASE FINISH; on standby, then SWITCHOVER TO PRIMARY.',
      'Update tnsnames.ora and EBS DB profile options to reflect new primary host.',
      'Run AutoConfig on app tier to pick up new DB connection parameters.',
      'Resync RMAN catalog: RESYNC CATALOG; Verify with LIST DB INCARNATION;',
    ],
  },
  v122: {
    description: 'EBS 12.2.x Data Guard switchover must account for adop edition state. RMAN resync after switchover may fail with ORA-12850 if RAC parallel slaves cannot coordinate across instances in the new primary cluster. The run edition must be verified post-switchover.',
    steps: [
      'Before switchover, ensure adop is not in a mid-cycle state: check AD_ADOP_SESSIONS for INCOMPLETE sessions.',
      'Perform Data Guard switchover: use DGMGRL or SQL*Plus ALTER DATABASE switchover commands.',
      'Post-switchover: verify all RAC instances on new primary are OPEN/ACTIVE: SELECT inst_id, status FROM gv$instance;',
      'Check PARALLEL_EXECUTION_MESSAGE_SIZE is identical across all instances before running RMAN.',
      'Resync RMAN catalog: RESYNC CATALOG; If ORA-12850 occurs, use ALTER SESSION SET INSTANCE=1 workaround in RMAN run block.',
      'Run AutoConfig on EBS app tier to update connection strings. Verify run edition services restart cleanly.',
    ],
  },
});

const PERFORMANCE = buildSection({
  v11i: {
    description: 'EBS 11i performance tuning relies on Statspack (AWR not available without Enterprise Edition + Diagnostics Pack). Application tier tuning focuses on Apache JVM settings and concurrent manager worker allocation.',
    steps: [
      'Collect Statspack snapshot: exec statspack.snap; Compare two snapshots with spreport.sql.',
      'Tune OPEN_CURSORS and SESSION_CACHED_CURSORS for cursor-heavy EBS workloads.',
      'Run FND_STATS.GATHER_SCHEMA_STATISTICS(\'APPS\') to refresh optimizer statistics.',
      'Tune CM worker allocation: increase $FND_TOP/sql/AFCPWRK count for high-throughput environments.',
      'Monitor Apache processes: ps -ef | grep httpd. Tune MaxClients in httpd.conf for concurrent user load.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 with Oracle Database 11g supports AWR, ASH, and ADDM. Application tier OC4J JVM tuning is the main app-tier lever. Forms cache settings in $INST_TOP affect response times.',
    steps: [
      'Collect AWR report: @$ORACLE_HOME/rdbms/admin/awrrpt.sql. Focus on Top SQL and wait events.',
      'Gather optimizer stats: FND_STATS.GATHER_SCHEMA_STATISTICS(\'APPS\', cascade=>TRUE);',
      'Tune OC4J JVM: adjust -Xms/-Xmx in $INST_TOP/ora/10.1.3/j2ee/oacore/config/oc4j.properties.',
      'Review concurrent manager request throughput. Increase CM workers for parallel processing needs.',
      'Check ASH for blocking locks: SELECT * FROM v$active_session_history WHERE event LIKE \'%enq%\';',
    ],
  },
  v122: {
    description: 'EBS 12.2.x performance tuning spans the Oracle Database (AWR/ASH/ADDM) and the WebLogic application tier. Thread dump analysis for WebLogic stuck threads and adop session overhead are 12.2-specific considerations.',
    steps: [
      'Collect AWR: @$ORACLE_HOME/rdbms/admin/awrrpt.sql. Use ASH for point-in-time wait analysis.',
      'WebLogic thread analysis: trigger thread dump from WL Admin Console or kill -3 <WL PID>. Look for stuck threads.',
      'Tune WebLogic thread pool: WL Admin Console → Servers → oacore → Tuning → Min/Max Thread Count.',
      'Run FND_STATS.GATHER_SCHEMA_STATISTICS(\'APPS\') after large data loads or patches.',
      'Monitor adop sessions during patching: SELECT * FROM AD_ADOP_SESSIONS WHERE STATUS=\'RUNNING\';',
      'Check concurrent manager throughput via FND_CONCURRENT_REQUESTS and adjust CM work shifts.',
    ],
  },
});

const ISTORE = buildSection({
  v11i: {
    description: 'EBS 11i iStore uses the standard Oracle HTTP Server (Apache) for web delivery. DMZ configurations in 11i use Apache reverse proxy. There is no WebLogic or OC4J in the architecture.',
    steps: [
      'Configure $ORACLE_HOME/Apache/Apache/conf/httpd.conf for reverse proxy and iStore module.',
      'Set iStore profile options (IBE_%): site URL, catalog, and security settings via System Administrator.',
      'For DMZ configuration, place an Apache reverse proxy in the DMZ pointing to the internal OHS.',
      'Test iStore URL: http://<host>:<port>/OA_HTML/ibeCCtpSctDspRte.jsp.',
      'Monitor Apache error_log for iStore servlet errors.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 iStore runs on OC4J behind OHS. The DMZ reverse proxy forwards requests to the internal OHS, which then routes to OC4J. The iStore Java servlets run in OC4J (oacore).',
    steps: [
      'Configure OHS reverse proxy for DMZ: mod_proxy in $INST_TOP/ora/10.1.2/Apache/Apache/conf/.',
      'Verify OC4J oacore deployment: opmnctl status -l. Check iStore servlet in OC4J application list.',
      'Set IBE profile options in System Administrator → Profile → System for iStore URL and catalog.',
      'Test from DMZ: https://<public_host>/OA_HTML/ibeCCtpSctDspRte.jsp.',
      'Monitor $INST_TOP/logs/ora/10.1.3/j2ee/oacore/application.log for servlet errors.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x iStore runs on WebLogic (oacore managed server) behind OHS. The DMZ public tier uses OHS as the reverse proxy entry point. WebLogic cluster configuration governs load balancing across mid-tier nodes.',
    steps: [
      'OHS acts as reverse proxy to WebLogic cluster: configure mod_wl_ohs in $INST_TOP/ora/10.1.2/ohs/conf/.',
      'Verify oacore managed server status: $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore.',
      'For DMZ, place OHS instance in DMZ pointing to internal WebLogic cluster via T3/HTTP.',
      'Set IBE profile options. Verify iStore catalog and pricelist assignment in iStore Admin console.',
      'Monitor WL Admin Console → oacore → Monitoring → Requests for iStore servlet throughput.',
    ],
  },
});

const DEMANTRA = buildSection({
  v11i: {
    description: 'Oracle Demantra was an independently acquired product and was not natively integrated with EBS 11i. Integration required custom extract/load processes. Running Demantra with an 11i EBS requires manual data pipeline configuration.',
    steps: [
      'Demantra runs as a standalone application with its own database schema. No native EBS 11i connector exists.',
      'Implement custom extracts from EBS 11i using UTL_FILE or database links to feed Demantra input tables.',
      'Configure Demantra Analytical Engine to pull from the extracted data.',
      'Publish forecasts back to EBS 11i via custom PL/SQL or file-based import.',
      'Monitor Demantra engine logs in <demantra_home>/logs/ for Bayesian engine errors.',
    ],
  },
  v1213: {
    description: 'Demantra integration with EBS 12.1.3 uses the Demantra Connector for E-Business Suite. Data flows through the ASCP workbench. The connector uses database links between EBS and the Demantra schema.',
    steps: [
      'Verify Demantra schema is accessible from EBS DB: SELECT * FROM dba_db_links WHERE db_link LIKE \'%DEMANTRA%\';',
      'Configure ASCP integration: run MSC_DEMANTRA_COLLECT concurrent program to extract EBS demand data.',
      'Verify Demantra Analytical Engine connectivity: check <demantra_home>/config/Dbconnection.properties.',
      'Publish engine results: run MSC_DEMANTRA_PUBLISH to push forecasts back into EBS planning.',
      'Monitor concurrent program logs for MSC_DEMANTRA_COLLECT failures in FND_CONCURRENT_REQUESTS.',
    ],
  },
  v122: {
    description: 'Demantra 12.2 integration leverages the same ASCP connector pattern but must account for the EBS 12.2 dual-filesystem environment. Demantra engines connect to the EBS database tier directly, unaffected by the run/patch edition split.',
    steps: [
      'Verify database-tier connectivity: Demantra connects to the Oracle database schema, not the app tier — no edition impact.',
      'Run MSC_DEMANTRA_COLLECT concurrent program from the run edition app tier.',
      'Verify Demantra engine host can reach EBS DB: tnsping <ebs_service> from Demantra server.',
      'For 12.2 on Oracle 19c: verify Demantra schema compatibility. Apply Demantra patches for 19c support.',
      'Monitor engine logs: <demantra_home>/tomcat/logs/catalina.out for JVM and DB connection errors.',
    ],
  },
});

const DB_OPS = buildSection({
  v11i: {
    description: 'Database operations in EBS 11i environments use standard Oracle DBA procedures without edition awareness. RMAN backup targets the single primary database. Sequence management uses standard Oracle DDL.',
    steps: [
      'RMAN backup: connect target / catalog <rman_user>/<pass>@<catalog>; BACKUP DATABASE PLUS ARCHIVELOG;',
      'Monitor sequences near limit: SELECT sequence_name, max_value, last_number FROM dba_sequences WHERE (max_value - last_number) < 1000000;',
      'For block corruption: RMAN VALIDATE CHECK LOGICAL DATABASE; Review V$DATABASE_BLOCK_CORRUPTION.',
      'Statistics: FND_STATS.GATHER_SCHEMA_STATISTICS(\'APPS\'); Run after large data changes.',
      'Archive log management: configure LOG_ARCHIVE_DEST and LOG_ARCHIVE_FORMAT in spfile.',
    ],
  },
  v1213: {
    description: 'Database operations in EBS 12.1.3 follow the same patterns as 11i with improved RMAN capabilities in Oracle 11g. AWR snapshot management becomes available. FND_STATS is still the recommended statistics tool.',
    steps: [
      'RMAN: use catalog-based backup with incremental strategy. Configure RMAN retention policy to match DR requirements.',
      'Monitor sequences: same query against DBA_SEQUENCES. EBS 12.1.3 uses sequences extensively in AR, OM, and AP.',
      'Block corruption scan: RMAN VALIDATE CHECK LOGICAL DATABASE; for weekly health checks.',
      'AWR baseline: create an AWR baseline during peak hours for performance comparison.',
      'FND_STATS for optimizer statistics. Schedule GATHER_SCHEMA_STATISTICS weekly.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x database operations must account for online redefinition tables, edition-based object tracking, and RAC coordination. RMAN catalog resync requires all RAC instances to be healthy (ORA-12850 risk). Sequence management is more complex due to parallel RAC caches.',
    steps: [
      'RMAN backup: verify all RAC instances are OPEN before catalog resync. Check gv$instance before each backup.',
      'For ORA-12850 during RMAN resync: use ALTER SESSION SET INSTANCE=1 in RMAN run block as workaround.',
      'Monitor sequences across RAC: note CACHE values inflate apparent gaps; true exhaustion needs last_number check on all instances.',
      'Block corruption: RMAN VALIDATE on each data file. EBS 12.2 edition tables (editioning views) add complexity — validate at segment level.',
      'Statistics: FND_STATS.GATHER_SCHEMA_STATISTICS(\'APPS\'); Avoid gathering during adop cutover window.',
    ],
  },
});

const MATERIAL_SOURCING = buildSection({
  v11i: {
    description: 'Material Sourcing (Pick Release) in EBS 11i runs as a standard concurrent program under the Discrete Manufacturing module. Pick release failures are typically caused by workflow or inventory setup issues, not application tier edition problems.',
    steps: [
      'Enable Pick Release trace: set profile option \'INV: Debug Trace\' = Yes for the user/responsibility.',
      'Check INV_DEBUG_LEVEL for granularity. Trace files write to utl_file_dir.',
      'Verify inventory organization and subinventory picking rules in Inventory → Setup → Picking.',
      'Check MO_GLOBAL context: SELECT MO_GLOBAL.GET_CURRENT_ORG_ID FROM DUAL; (should return valid org).',
      'Review concurrent program output for ORA errors in FND_CONCURRENT_REQUESTS.OUTPUT_FILE_ID.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 Pick Release uses the same concurrent program framework. Multi-org (MO) context handling became more rigorous in 12.1.3 — MO_GLOBAL.SET_POLICY_CONTEXT must be called correctly in custom code.',
    steps: [
      'Verify MO setup: MO profile options (MO: Operating Unit, MO: Security Profile) correct for the responsibility.',
      'Enable trace: set INV: Debug Trace = Yes and collect trace from utl_file_dir.',
      'For intermittent failures, check if third-party integration callbacks are timing out: identify callout in trace.',
      'Query WF_ITEM_ACTIVITY_STATUSES for stuck workflow activities related to the Pick Release workflow.',
      'Review $INST_TOP/logs/appl/rgf/ for concurrent program stack traces.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x Pick Release runs on the run edition app tier. Edition-based redefinition of INV tables can occasionally cause unexpected plan changes after adop cutover. Monitoring should cover both concurrent program logs and WebLogic thread state.',
    steps: [
      'Source run edition: . $EBS_DOMAIN_HOME/EBSapps.env run before running diagnostic queries.',
      'Check for locked rows in WMS_EXCEPTIONS and INV_MOVE_ORDER_LINES that may block pick release.',
      'Enable INV: Debug Trace. Trace files in utl_file_dir (check profile option for path).',
      'Post adop cutover: verify materialized views on INV tables are fresh: SELECT mview_name, staleness FROM user_mviews;',
      'For concurrent program hangs, check WebLogic oacore thread dumps for JDBC waits.',
    ],
  },
});

const FUSION_MIGRATION = buildSection({
  v11i: {
    description: 'Migrating from EBS 11i to Oracle Fusion ERP (Oracle Cloud ERP) is a full reimplementation project, not an in-place upgrade. No direct technical upgrade path exists from 11i to Fusion. Data migration requires extensive extract, transform, and load work.',
    steps: [
      'Assess 11i customizations: use the EBS Customization Analyzer to catalog custom objects, reports, and workflows.',
      'Map 11i data entities to Fusion equivalents. Use Oracle Cloud Readiness documentation for functional mapping.',
      'Plan a phased migration: GL first, then AR/AP, then Order Management — to manage risk.',
      'Use Oracle Data Migration tools (FBDI, REST APIs, or HCM Data Loader as appropriate per module).',
      'Consider upgrading to 12.2 first for a better-supported migration path and access to Oracle Lift tools.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 to Oracle Fusion Cloud ERP migration follows Oracle\'s recommended upgrade path: upgrade to EBS 12.2 first, then use Oracle-supported migration tooling. Direct 12.1.3 → Fusion migration is technically possible but lacks Oracle tooling support.',
    steps: [
      'Upgrade to EBS 12.2 first: this gives access to Oracle\'s Fusion migration accelerators and support lifecycle.',
      'Use the Oracle Cloud Adoption framework to assess modules in scope for Fusion migration.',
      'Extract master data (customers, suppliers, items, COA) from 12.1.3 using FND data extracts.',
      'Validate Fusion configuration matches 12.1.3 business rules before cutover.',
      'Plan historical data archiving in 12.1.3 for regulatory compliance post-cutover.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x is the supported migration source for Oracle Fusion Cloud ERP. Oracle provides tooling including Oracle Lift, Cloud Migration workbench, and FBDI templates specifically for 12.2-to-Fusion migrations.',
    steps: [
      'Engage Oracle Consulting or a certified implementation partner for the migration assessment.',
      'Use Oracle Cloud Readiness dashboard to compare EBS 12.2 modules with Fusion equivalents.',
      'Extract transactional data using FBDI templates. Validate against Fusion import control files.',
      'Migrate open transactions (open POs, open invoices, open orders) at cutover using Oracle-provided migration scripts.',
      'Plan a parallel run period where both EBS 12.2 and Fusion are live for reconciliation.',
    ],
  },
});

const SEQUENCE_MGMT = buildSection({
  v11i: {
    description: 'Oracle EBS 11i uses standard database sequences extensively across all modules. Sequence limit exhaustion causes ORA-08004 errors. In 11i there is no RAC cache drift to consider — sequence values are directly from the single-instance sequence object.',
    steps: [
      'Identify near-limit sequences: SELECT sequence_name, last_number, max_value FROM dba_sequences WHERE owner=\'APPS\' AND (max_value - last_number) < 500000 ORDER BY (max_value-last_number);',
      'Alter sequence to reset: alter_sequence.sql or call FNDSEQ (Apps sequence management package).',
      'For ORA-01403 (no data found) or ORA-08004 in concurrent programs, trace the failing call to identify the sequence.',
      'Set CYCLE=NO on all critical sequences to get clean errors rather than silent wrap-around.',
      'Schedule weekly monitoring with a cron that queries DBA_SEQUENCES and alerts when gap < 1M.',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 sequence management is identical to 11i. Sequences are non-partitioned, single-instance objects. The same monitoring and remediation procedures apply.',
    steps: [
      'Monitor with: SELECT sequence_name, last_number, max_value, (max_value-last_number) remaining FROM dba_sequences WHERE owner=\'APPS\' ORDER BY remaining;',
      'Use FNDSEQ package or ALTER SEQUENCE to increase max_value or reset last_number.',
      'For AR transaction sequences: ensure RA_CUSTOMER_TRX_ALL.TRX_NUMBER sequence does not conflict with manual numbering.',
      'Alert threshold: set cron monitoring when remaining < 2,000,000 for high-volume sequences.',
      'After sequence reset, verify active concurrent programs resume cleanly without caching stale values.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x sequence management adds RAC CACHE complexity. Each RAC instance caches a block of sequence values (CACHE n). The effective last_number across all instances may be higher than DBA_SEQUENCES.LAST_NUMBER shows. Monitor from GV$SEQUENCES for accurate cross-instance view.',
    steps: [
      'Query cross-instance sequence state: SELECT inst_id, sequence_name, last_number FROM gv$sequences WHERE sequence_owner=\'APPS\' ORDER BY sequence_name, inst_id;',
      'Use the highest LAST_NUMBER across all instances as the true high watermark.',
      'Alert when (max_value - max(last_number across instances)) < 2,000,000 for high-volume sequences.',
      'During adop patching, some sequences in the patch edition may be advanced. Verify post-cutover.',
      'Use FNDSEQ package procedures for safe sequence management in EBS context.',
    ],
  },
});

const RMAN_DG = buildSection({
  v11i: {
    description: 'RMAN archive log management in EBS 11i Data Guard environments must account for archive log retention on the primary. RMAN-08120 (archive not yet applied on standby) is a standard concern for properly configured RMAN deletion policies.',
    steps: [
      'Check archive log status: SELECT sequence#, applied, deleted FROM v$archived_log ORDER BY sequence# DESC;',
      'Verify standby is receiving and applying logs: check V$ARCHIVE_DEST_STATUS for each destination.',
      'Configure RMAN deletion policy: CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;',
      'If logs pile up, verify standby apply: ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;',
      'Test deletion policy: RMAN > DELETE ARCHIVELOG UNTIL TIME \'SYSDATE - 7\';',
    ],
  },
  v1213: {
    description: 'EBS 12.1.3 RMAN and Data Guard follow the same pattern as 11i with improved Oracle 11g Data Guard features. Real-time apply and Active Data Guard (read-only standby) are available with Enterprise Edition.',
    steps: [
      'Enable real-time apply on standby: ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;',
      'Check RMAN deletion policy is consistent with Data Guard: SHOW ARCHIVELOG DELETION POLICY;',
      'For Active Data Guard (read-only standby), verify RMAN can backup FROM STANDBY for offload.',
      'Monitor V$DATAGUARD_STATUS for transport lag and apply lag.',
      'RMAN catalog resync after switchover: RESYNC CATALOG; from the new primary.',
    ],
  },
  v122: {
    description: 'EBS 12.2.x RMAN with Data Guard must handle RAC coordination. RMAN catalog resync after a Data Guard switchover can fail with ORA-12850 if RAC instances are not all in a clean OPEN/ACTIVE state post-switchover.',
    steps: [
      'Post-switchover: verify all RAC instances open cleanly: SELECT inst_id, status FROM gv$instance;',
      'Check PARALLEL_EXECUTION_MESSAGE_SIZE is identical on all instances before running RMAN.',
      'If ORA-12850 occurs in RMAN resync, use workaround: add SQL "ALTER SESSION SET INSTANCE=1" in the RMAN run block.',
      'Configure RMAN deletion policy: CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;',
      'Full resync after cluster stabilizes: RESYNC CATALOG; Verify with LIST DB INCARNATION;',
    ],
  },
});

const BLOCK_CORRUPTION = buildSection({
  v11i: {
    description: 'Oracle block corruption (fractured or media corruption) in EBS 11i environments is diagnosed and resolved with standard RMAN and DBMS_REPAIR procedures. No edition awareness is required.',
    steps: [
      'Identify corruption: RMAN VALIDATE CHECK LOGICAL DATABASE; Review V$DATABASE_BLOCK_CORRUPTION.',
      'Attempt block media recovery: RMAN BLOCKRECOVER DATAFILE <n> BLOCK <m>;',
      'If RMAN recovery not possible (corrupt backups), use DBMS_REPAIR to mark corrupt blocks as soft corrupt and skip.',
      'Run ANALYZE TABLE ... VALIDATE STRUCTURE CASCADE on affected tables to confirm repaired.',
      'Rebuild or reorganize affected segment: ALTER TABLE ... MOVE; Rebuild indexes afterward.',
    ],
  },
  v1213: {
    description: 'Block corruption diagnosis in EBS 12.1.3 follows the same RMAN/DBMS_REPAIR pattern. Oracle 11g RMAN provides better VALIDATE and BLOCKRECOVER capabilities than 10g.',
    steps: [
      'Run RMAN VALIDATE CHECK LOGICAL DATABASE; weekly as a health check.',
      'Query V$DATABASE_BLOCK_CORRUPTION for identified corrupt blocks.',
      'BLOCKRECOVER: RMAN BLOCKRECOVER CORRUPTION LIST; (uses most recent backup automatically).',
      'If segment rebuild is needed: ALTER TABLE <owner>.<table> MOVE TABLESPACE <ts>; then REBUILD indexes.',
      'After recovery, run FND_STATS.GATHER_TABLE_STATS on affected tables.',
    ],
  },
  v122: {
    description: 'Block corruption in EBS 12.2.x must consider edition-based objects. Editioning views, edition triggers, and edition-private synonyms add layers to the object stack. Validate at the base table level, not the editioning view level.',
    steps: [
      'Validate at base table: RMAN VALIDATE CHECK LOGICAL DATAFILE <n>; Review V$DATABASE_BLOCK_CORRUPTION.',
      'Identify edition context: SELECT object_name, object_type, edition_name FROM dba_objects_ae WHERE status=\'INVALID\';',
      'BLOCKRECOVER with RMAN. After recovery, verify editioning views and edition triggers compile cleanly.',
      'Recompile invalid objects: @$ORACLE_HOME/rdbms/admin/utlrp.sql;',
      'Verify adop is not in mid-cycle — block recovery during adop cutover can leave edition objects in inconsistent state.',
    ],
  },
});

const ORA29024_WALLET = buildSection({
  v11i: {
    description: 'ORA-29024 (certificate validation failure) in EBS 11i occurs when UTL_HTTP or payment processing cannot validate the SSL certificate chain of the remote endpoint. Oracle Wallet management in 11i uses orapki against the $ORACLE_HOME wallet.',
    steps: [
      'Identify SSL endpoint: check FND_PROFILE_OPTION_VALUES for payment gateway URL or UTL_HTTP call target.',
      'Add CA certificate to Oracle Wallet: orapki wallet add -wallet $ORACLE_HOME/wallets/server -trusted_cert -cert ca.cer -auto_login.',
      'Verify chain: orapki wallet display -wallet $ORACLE_HOME/wallets/server.',
      'Test SSL connection: openssl s_client -connect <host>:<port> -CAfile ca.cer.',
      'Reload OHS/httpd after wallet change: $ADMIN_SCRIPTS_HOME/adapcctl.sh restart.',
    ],
  },
  v1213: {
    description: 'ORA-29024 in EBS 12.1.3 involves Oracle Wallet on the OHS tier and JSSE truststore for Java components on OC4J. Both must trust the payment gateway CA chain.',
    steps: [
      'Add trusted cert to OHS wallet: orapki wallet add -wallet $INST_TOP/ora/10.1.2/.../wallet -trusted_cert -cert ca.cer -auto_login.',
      'Add to OC4J Java truststore (for Java-based payment integration): keytool -importcert -keystore $JAVA_HOME/jre/lib/security/cacerts -alias <alias> -file ca.cer.',
      'Test from DB using UTL_HTTP: UTL_HTTP.SET_WALLET(\'file:$INST_TOP/ora/10.1.2/.../wallet\', \'<pass>\');',
      'Restart OHS: adapcctl.sh restart. Restart OC4J: opmnctl restartproc ias-component=oacore.',
      'Verify payment request completes by running a test transaction through the payment module.',
    ],
  },
  v122: {
    description: 'ORA-29024 in EBS 12.2.x can affect OHS wallet, WebLogic JKS truststore, and Oracle DB wallet used by UTL_HTTP. All three trust stores may need updating for payment gateway CA chain changes. AutoConfig regenerates wallet paths — use txkSetContextParam.pl to preserve wallet configuration.',
    steps: [
      'Update OHS wallet: orapki wallet add -wallet <wallet_path> -trusted_cert -cert ca.cer -auto_login.',
      'Update WebLogic truststore: keytool -importcert -keystore $WL_HOME/server/lib/DemoTrust.jks -alias <alias> -file ca.cer.',
      'Update DB wallet (for UTL_HTTP): orapki wallet add -wallet $ORACLE_HOME/wallets/dbwallet -trusted_cert -cert ca.cer -auto_login.',
      'Use txkSetContextParam.pl to register wallet path in context file so AutoConfig does not overwrite.',
      'Restart OHS and WebLogic: adapcctl.sh restart; admanagedsrvctl.sh restart oacore.',
    ],
  },
});

// ── Slug → section map ─────────────────────────────────────────────────────

const SLUG_MAP: Record<string, string> = {
  // adop-only
  'ebs-12-2-online-patching-adop': ADOP_ONLY,
  'ebs-12-2-adop-patching-phases': ADOP_ONLY,
  'oracle-ebs-12211-adop-online-patching': ADOP_ONLY,
  'oracle-ebs-12211-adop-online-patching-runbook': ADOP_ONLY,
  'ebs-adop-checkfile-failure-troubleshooting': ADOP_ONLY,
  'ebs-adop-checkfile-failure-runbook': ADOP_ONLY,
  'ebs-adop-run-filesystem-sync-patch-edition': ADOP_ONLY,
  'ebs-adop-run-filesystem-sync-runbook': ADOP_ONLY,

  // general patching
  'ebs-patching-strategy-guide': PATCHING_GENERAL,
  'ebs-patching-end-to-end-runbook': PATCHING_GENERAL,
  'ebs-patching-fndload-ldt-worker-failure-troubleshooting': PATCHING_GENERAL,
  'ebs-patching-fndload-ldt-worker-failure-runbook': PATCHING_GENERAL,
  'ebs-patching-workers-stuck-running-blocking-locks': PATCHING_GENERAL,
  'ebs-patching-workers-stuck-running-blocking-locks-runbook': PATCHING_GENERAL,
  'ebs-patching-filesystem-sync-failure-stalled-workers': PATCHING_GENERAL,
  'ebs-patching-filesystem-sync-failure-runbook': PATCHING_GENERAL,

  // concurrent manager
  'ebs-concurrent-manager-metadata-growth': CONCURRENT_MANAGER,
  'ebs-concurrent-manager-metadata-purge-runbook': CONCURRENT_MANAGER,
  'ebs-concurrent-requests-slow-diagnosis': CONCURRENT_MANAGER,
  'ebs-concurrent-requests-slow-runbook': CONCURRENT_MANAGER,
  'ebs-fndwfpr-rac-dbms-parallel-execute-instance-pinning': CONCURRENT_MANAGER,
  'ebs-fndwfpr-rac-instance-pinning-runbook': CONCURRENT_MANAGER,
  'ebs-concurrent-request-rac-parallel-slave-crash-diagnosis': CONCURRENT_MANAGER,
  'ebs-concurrent-request-rac-crash-diagnosis-runbook': CONCURRENT_MANAGER,
  'oracle-ebs-concurrent-manager': CONCURRENT_MANAGER,
  'oracle-ebs-concurrent-manager-runbook': CONCURRENT_MANAGER,
  'oracle-ebs-autoinvoice-zombie-request': CONCURRENT_MANAGER,
  'oracle-ebs-autoinvoice-zombie-request-runbook': CONCURRENT_MANAGER,
  'oracle-ebs-postclone-autoinvoice-ora03113': CONCURRENT_MANAGER,
  'oracle-ebs-postclone-autoinvoice-ora03113-runbook': CONCURRENT_MANAGER,
  'ebs-stuck-hogging-thread-awr-statistical-analysis': CONCURRENT_MANAGER,
  'ebs-concurrent-program-performance-data-warehouse-runbook': CONCURRENT_MANAGER,

  // TLS/SSL
  'oracle-ebs-12-2-tls-certificates-configuration': TLS_SSL,
  'oracle-ebs-12-2-tls-certificate-installation-runbook': TLS_SSL,
  'ebs-weblogic-ohs-demo-certificate-expiry': TLS_SSL,
  'ebs-weblogic-ohs-demo-certificate-expiry-runbook': TLS_SSL,
  'ebs-12-2-outbound-soap-pkix-ssl-truststore-fix': TLS_SSL,
  'ebs-outbound-soap-pkix-ssl-truststore-runbook': TLS_SSL,
  'ssl-certificate-chain-depth-oracle-ebs': TLS_SSL,
  'ssl-certificate-chain-depth-runbook': TLS_SSL,
  'oracle-wallet-certificate-monitoring': TLS_SSL,
  'oracle-wallet-certificate-monitoring-runbook': TLS_SSL,

  // ORA-29024 / payment gateway SSL
  'ora-29024-oracle-ebs-credit-card-ssl-wallet': ORA29024_WALLET,
  'ora-29024-oracle-ebs-ssl-wallet-runbook': ORA29024_WALLET,

  // code signing
  'ebs-code-signing-certificate-adkeystore': CODE_SIGNING,
  'ebs-why-code-signing-required': CODE_SIGNING,
  'ebs-12-2-jar-certificate-audit': CODE_SIGNING,

  // filesystem
  'ebs-12-2-file-system-explained': FILESYSTEM_ARCH,

  // SOA / WebLogic / integration
  'ebs-12-2-integrated-soa-gateway-b2b-50079': SOA_WEBLOGIC,
  'ebs-12-2-integrated-soa-gateway-health-check-runbook': SOA_WEBLOGIC,
  'ebs-12-2-weblogic-clustering-load-balancing-monitoring': SOA_WEBLOGIC,
  'ebs-12-2-weblogic-cluster-health-check-runbook': SOA_WEBLOGIC,
  'ebs-12-2-workflow-topology-queue-tables': SOA_WEBLOGIC,
  'ebs-12-2-workflow-health-check-purge-runbook': SOA_WEBLOGIC,
  'ebs-iby-0001-jdbc-cursor-leak-payment-servlet': SOA_WEBLOGIC,
  'ebs-iby-0001-cursor-leak-remediation-runbook': SOA_WEBLOGIC,

  // TNS/JDBC
  'ebs-custom-jdbc-tns-descriptors-autoconfig-survival': TNS_JDBC,
  'ebs-custom-jdbc-tns-descriptors-runbook': TNS_JDBC,

  // Forms / browser
  'ebs-forms-browser-configuration': FORMS,
  'ebs-forms-browser-configuration-runbook': FORMS,
  'ebs-forms-frm40735-ora01001-invalid-cursor-troubleshooting': FORMS,
  'ebs-forms-frm40735-ora01001-runbook': FORMS,

  // LDAP
  'ebs-ldap-integration-troubleshooting': LDAP,
  'ebs-ldap-integration-runbook': LDAP,

  // install / clone / upgrade
  'oracle-ebs-12-2-9-oracle-19c-rhel8-docker': INSTALL_CLONE,
  'oracle-ebs-12-2-9-oracle-19c-rhel8-docker-runbook': INSTALL_CLONE,
  'oracle-ebs-12-2-9-vision-demo-install': INSTALL_CLONE,
  'oracle-ebs-12-2-9-vision-demo-install-runbook': INSTALL_CLONE,
  'oracle-ebs-12211-clone-pdb-rhel9': INSTALL_CLONE,
  'oracle-ebs-12211-pdb-clone-runbook': INSTALL_CLONE,
  'oracle-ebs-12211-cloning': INSTALL_CLONE,
  'oracle-ebs-12211-cloning-runbook': INSTALL_CLONE,
  'oracle-ebs-12211-upgrade': INSTALL_CLONE,
  'oracle-ebs-12211-upgrade-runbook': INSTALL_CLONE,

  // HA / DR / RAC / Data Guard
  'oracle-ebs-12211-rhel9-dr-architecture': HA_DR,
  'oracle-ebs-12211-rhel9-dr-runbook': HA_DR,
  'oracle-ebs-12211-dr-snapshot-standby-test': HA_DR,
  'oracle-ebs-12211-dr-snapshot-standby-runbook': HA_DR,
  'oracle-ebs-12211-data-guard': HA_DR,
  'oracle-ebs-12211-data-guard-runbook': HA_DR,
  'oracle-ebs-12211-rac': HA_DR,
  'oracle-ebs-12211-rac-runbook': HA_DR,

  // RMAN / Data Guard archive logs
  'rman-08120-applied-on-all-standby': RMAN_DG,
  'rman-08120-applied-on-all-standby-runbook': RMAN_DG,

  // performance
  'oracle-ebs-12211-performance-tuning': PERFORMANCE,
  'oracle-ebs-12211-performance-tuning-runbook': PERFORMANCE,

  // iStore DMZ
  'ebs-istore-dmz-public-mid-tier-architecture': ISTORE,
  'ebs-istore-dmz-public-mid-tier-runbook': ISTORE,

  // Demantra
  'oracle-demantra-demand-forecasting-naive-bayes': DEMANTRA,
  'oracle-demantra-19c-rhel9-installation-runbook': DEMANTRA,

  // block corruption
  'oracle-fractured-free-block-corruption': BLOCK_CORRUPTION,
  'oracle-fractured-free-block-corruption-runbook': BLOCK_CORRUPTION,

  // sequence management
  'oracle-ebs-sequence-limit-management': SEQUENCE_MGMT,
  'oracle-ebs-sequence-limit-management-runbook': SEQUENCE_MGMT,

  // misc DB / general EBS
  'oracle-ebs-material-sourcing-process-failed': MATERIAL_SOURCING,
  'oracle-ebs-material-sourcing-process-failed-runbook': MATERIAL_SOURCING,

  // EBS to Fusion migration
  'ebs-to-fusion-erp-migration-strategy': FUSION_MIGRATION,
  'ebs-to-fusion-erp-migration-runbook': FUSION_MIGRATION,

  // general DB ops posts
  'oracle-ebs-12211-rhel9-dr-architecture': HA_DR,
};

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const slugs = Object.keys(SLUG_MAP);
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const slug of slugs) {
    const rows = await db.select({ content: posts.content }).from(posts).where(eq(posts.slug, slug));
    if (rows.length === 0) {
      console.log(`MISSING: ${slug}`);
      missing++;
      continue;
    }
    const current = rows[0].content;
    if (current.includes(MARKER)) {
      console.log(`SKIP (already has section): ${slug}`);
      skipped++;
      continue;
    }
    const newContent = current + SLUG_MAP[slug];
    await db.update(posts).set({ content: newContent }).where(eq(posts.slug, slug));
    console.log(`UPDATED: ${slug}`);
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Missing: ${missing}`);
}

main().catch(console.error);
