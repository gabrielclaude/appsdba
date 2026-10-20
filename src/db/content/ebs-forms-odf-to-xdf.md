By Priya Subramaniam

What exactly changes when Oracle converts a Forms binary into an XML descriptor — and why does that conversion matter for the long-term viability of your EBS deployment?

Oracle Forms has defined the EBS user experience since the early 1990s. Every AP Invoice entry screen, every PO approval workflow, every HR employee record form was built using Oracle Designer and compiled into a binary `.fmb` source file and a corresponding `.fmx` runtime artifact. For three decades, this binary format was invisible to operations teams — you ran `f60gen` to compile, you deployed the `.fmx` to the middle tier, and users connected via the Forms servlet. The EBS Next Gen program disrupts this model by replacing the binary ODF format with a text-based XML Forms Definition (XDF) format that compiles and deploys through the same AD patching framework.

## ODF vs XDF: A Technical Comparison

**Oracle Developer Forms (ODF)** is Oracle's original Forms technology. The authoring artifact is a `.fmb` binary file produced by Oracle Forms Builder (historically called Oracle Designer). The binary is opaque — you cannot read or diff it with standard text tools. Compilation produces a `.fmx` runtime binary. Customizations are embedded directly in the binary: triggers are PL/SQL blocks stored inside the form, program units are PL/SQL packages attached to the form object.

**XML Forms Definition (XDF)** is the successor format introduced with EBS 12.2.x. The authoring artifact is a `.xdf` file — a well-formed XML document that describes every form object (blocks, items, triggers, LOVs, program units) in a structured, human-readable schema. Compilation still produces a `.fmx` runtime binary, but the source is now transparent, diffable, and storable in standard source control systems. The XDF XML schema is documented in Oracle's Forms Developer Guide.

Key structural differences:

- **ODF format**: Binary `.fmb` — opaque, no text diff, Java Plugin required at runtime
- **XDF format**: XML `.xdf` — human-readable, full text diff, AD-patchable, HTML5 servlet
- **ODF compilation**: `f60gen` / `frmcmp` — produces `.fmx` binary
- **XDF compilation**: `frmcmp_batch` (XDF-aware) — produces same `.fmx` binary
- **ODF merge tool**: Forms Builder GUI only
- **XDF merge tool**: `frmxmlconv` command-line XML merge

## The Forms Migration Assistant (FMA)

Oracle provides the Forms Migration Assistant as part of the EBS AD patch framework. FMA performs a mechanical conversion from ODF binary to XDF XML. It does not rewrite business logic — all PL/SQL triggers, program units, and property overrides are preserved verbatim in the XDF output.

### Running FMA

FMA is invoked via the `adformgen.pl` script in the `$AD_TOP/bin` directory:

```bash
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  fmb_file=$AU_TOP/forms/US/APXINWKB.fmb \
  xdf_file=$AU_TOP/forms/US/APXINWKB.xdf \
  mode=CONVERT
```

For bulk conversion of all forms in a product top:

```bash
perl $AD_TOP/bin/adformgen.pl \
  apps_user=apps \
  apps_pwd=<apps_password> \
  product_top=$AP_TOP \
  mode=CONVERT_ALL \
  logfile=/u01/logs/ap_forms_conversion.log
```

FMA writes a conversion log that reports each form's conversion status: SUCCESS, WARNING, or ERROR. Forms that report WARNING have been converted but contain constructs that require manual review (typically legacy PL/SQL built-ins that were deprecated between Forms 6i and Forms 12c). Forms that report ERROR failed conversion and require manual intervention.

### Common Conversion Warnings

- **EXEC_MACRO calls** — the `EXEC_MACRO` built-in is not supported in XDF. FMA flags these but does not remove them; they must be replaced with equivalent trigger logic.
- **WIN.ACTIVATE calls** — window activation semantics changed between Forms 6 and Forms 12. FMA converts these but marks them for testing.
- **HOST() built-in** — calls to the Forms `HOST()` built-in (which invoked OS shell commands from the client) are flagged; in XDF/browser mode, `HOST()` is blocked for security reasons. These must be replaced with concurrent program submissions.
- **Deprecated color constants** — color specifications using Forms 6 color index values (integers) must be replaced with named color strings.

## Compiling XDF Forms

After conversion, XDF files are compiled using `frmcmp_batch`, the command-line compiler that ships with Oracle Forms 12c (bundled in the EBS 12.2.x middle tier):

```bash
frmcmp_batch \
  module=$AU_TOP/forms/US/APXINWKB.xdf \
  userid=apps/<apps_password>@<db_connect_string> \
  output_file=$AU_TOP/forms/US/APXINWKB.fmx \
  module_type=FORM \
  compile_all=YES
```

The output `.fmx` is functionally identical to the ODF-compiled `.fmx` — it deploys to the same middle-tier location and is served by the same Forms servlet. End users see no difference.

For production deployments, compilation is handled by the AD patching framework:

```bash
adpatch options=hotpatch
```

When an AD patch contains XDF files, `adpatch` invokes `frmcmp_batch` automatically. The DBA does not need to compile manually — the same AD workflow that has governed EBS patching for two decades handles XDF compilation.

## Handling Customizations

Custom Forms in EBS are typically stored in `$CUSTOM_TOP/forms/US/`. During an ODF-to-XDF migration, custom forms must be converted individually. Oracle recommends the following sequence for customized standard forms:

1. **Convert the baseline Oracle form** using FMA. This produces the reference XDF for the standard form at your current patch level.
2. **Apply your customizations** to the XDF using an XML-aware merge tool. Oracle provides `frmxmlconv` for this purpose, which performs a three-way merge between the original ODF customization, the baseline XDF, and the new XDF.
3. **Compile and regression test** the merged XDF. The test suite should cover every custom trigger and every modified LOV — the merge process is mechanical, not semantic, and can produce compilable XDF that does not behave identically to the original ODF form.
4. **Register the custom XDF** in the AD custom driver so future patches apply correctly.

The frmxmlconv merge command:

```bash
frmxmlconv \
  base=$AU_TOP/forms/US/APXINWKB_baseline.xdf \
  custom=$CUSTOM_TOP/forms/US/APXINWKB.fmb \
  new=$AU_TOP/forms/US/APXINWKB_patched.xdf \
  output=$CUSTOM_TOP/forms/US/APXINWKB_merged.xdf
```

## Deploying to the EBS Middle Tier

XDF-compiled `.fmx` files deploy to the same paths as ODF-compiled forms:

- Standard Oracle forms: `$AU_TOP/forms/US/`
- Custom forms: `$CUSTOM_TOP/forms/US/`

The middle tier's Forms servlet path configuration (in the WebLogic domain's `formsweb.cfg`) remains unchanged. There is no separate configuration file for XDF mode — the Forms 12c servlet detects the XDF-compiled `.fmx` format automatically.

After deploying new `.fmx` files, bounce the Forms managed server:

```bash
# Via WLST
wlst.sh << 'EOF'
connect('weblogic','<wls_password>','t3://<host>:7001')
domainRuntime()
shutdown('FormsServer_1','Server')
start('FormsServer_1','Server')
EOF
```

No EBS autoconfig or context file change is required for a standard forms deployment.

## Regression Testing Strategy

The XDF migration is a functional regression risk, not just a technical recompile. Oracle's own QA process for XDF migration covers:

- **Form open/close cycle** — verify the form opens without JavaScript errors in the browser console and closes cleanly.
- **Query mode** — execute a representative query for each data block and verify record counts match the ODF baseline.
- **Insert/update/delete cycle** — exercise every mandatory field, every LOV validation, and every cross-block validation trigger.
- **Custom trigger coverage** — each PL/SQL trigger present in the ODF source must be exercised at least once.
- **Concurrent program submission** — any form that submits a concurrent request must complete the submit cycle successfully.
- **Flexfield behavior** — key and descriptive flexfields must display, validate, and save correctly; the XDF compiler handles flexfield metadata differently from ODF in edge cases.

A practical regression matrix for a mid-complexity form (AP Invoice Entry, for example) runs to approximately 40–60 test cases. Oracle's Application Testing Suite (ATS) can automate a subset of these, but critical path testing by a functional expert remains essential.

## Summary

The ODF-to-XDF migration is the foundational technical step of the EBS Next Gen program. It converts Forms source from a binary artifact that resists source control and patching automation into a structured XML document that integrates naturally with modern DevOps practices. The FMA conversion is mechanical; the complexity lies in custom form merging, FMA warning remediation, and functional regression testing.

Key operational takeaways:

- **Run ETCC first.** The EBS Technology Codelevel Checker identifies which AD patches must be applied before FMA conversion is valid for a given EBS version.
- **Convert standard forms first, customizations second.** Establishing the XDF baseline for standard Oracle forms before attempting custom merges reduces merge conflicts.
- **Treat the migration as a patch event.** Use AD patching discipline — backup, change control, test in DEV/UAT before PROD — rather than treating it as a configuration exercise.
- **Audit HOST() calls in custom forms.** Any custom form that calls HOST() will require a refactor; HOST() is security-blocked in browser-mode Forms and is a migration blocker.
- **Plan for flexfield re-testing.** Flexfield rendering behavior has subtle differences between ODF and XDF compilations; allocate testing time specifically for flex fields.

## References

- [Oracle Forms Migration Assistant Guide 12c](https://docs.oracle.com/cd/E26401_01/doc.1221/e22953/toc.htm)
- [Oracle E-Business Suite Release 12.2 Maintenance Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22954/toc.htm)
- [Oracle Forms Developer Guide 12c](https://docs.oracle.com/middleware/12213/forms/develop-forms/index.html)
- [Oracle Application Development Framework Developer Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e21428/toc.htm)
- [Oracle E-Business Suite AD Utilities Reference Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22950/toc.htm)
- [Oracle E-Business Suite Technology Stack Administration Guide](https://docs.oracle.com/cd/E26401_01/doc.1221/e22956/toc.htm)
