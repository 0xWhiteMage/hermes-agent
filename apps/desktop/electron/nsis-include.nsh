# Combined NSIS include for the Hermes desktop installers. Wired from
# electron-builder.config.cjs through nsis.include (which takes ONE file);
# electron-builder splices customInit / customInstall / customUnInstall
# into the generated installer script.
#
# Two concerns live here:
#   1. Arch guard (customInit): refuse to run on the wrong machine.
#   2. CLI PATH exposure (customInstall/customUnInstall): make the bundled
#      payload's CLI shims reachable from any terminal.

!include "x64.nsh"

# ── Arch guard ───────────────────────────────────────────────────────────────
#
# The stock identify_package macro
# (app-builder-lib templates/nsis/include/extractAppPackage.nsh) treats an
# arm64 machine as a valid x64 host. An x64 installer on arm64 Windows
# installs silently and the app then runs in emulation forever. The reverse
# direction is worse: an arm64 installer on an x64 machine matches no
# package macro, so the installer "succeeds" and writes an EMPTY install.
#
# The defines and the native-machine tests come from the surrounding
# electron-builder machinery: APP_64/APP_ARM64 exist per embedded payload,
# x64.nsh supplies IsNativeAMD64/IsNativeARM64, which see through WOW
# emulation. The !ifndef nesting keeps a future multi-arch installer
# permissive: it carries both payloads, so it must not be blocked on
# either machine.
#
# MessageBox carries /SD IDOK so a silent install (/S, the electron-updater
# path) does not hang on a dialog. SetErrorLevel 2 = "installation aborted
# by script", so a silent wrong-arch install reports failure instead of
# pretending success.

!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND \
          "This installer is for Windows on ARM (arm64).$\r$\n$\r$\nThis computer is not arm64. Download the x64 installer instead." \
          /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif
  !endif
  !ifdef APP_64
    !ifndef APP_ARM64
      ${IfNot} ${IsNativeAMD64}
        MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND \
          "This installer is for x64 Windows.$\r$\n$\r$\nThis computer is not x64. Download the arm64 installer instead." \
          /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif
  !endif
!macroend

# ── CLI PATH exposure ────────────────────────────────────────────────────────
#
# A bundled install ships prebuilt, signed CLI shims (hermes.exe,
# hermes-agent.exe, hermes-acp.exe) inside the payload at
# resources\agent-payload\bin — staged by stage-agent-payloads.mjs, signed
# with the rest of the tree, self-relative via the shim-target.txt sidecar.
# The installer's ONLY job is to point the user PATH at that directory.
# Nothing is generated or copied at install time: post-install byte
# generation is exactly what a sealed, signed artifact cannot do.
#
# The dir added is the payload bin — NEVER $INSTDIR itself. $INSTDIR holds
# the GUI Hermes.exe, and NTFS name resolution is case-insensitive: with
# $INSTDIR on PATH, typing `hermes` in a terminal would launch the desktop
# app instead of the CLI.
#
# Gated on the shims actually existing so the external (non-bundled) NSIS
# artifact — which carries a stub payload with no bin/ — adds nothing.
#
# EnVar (shipped by electron-builder) targets the user scope (perMachine is
# false), handles REG_EXPAND_SZ correctly, and is idempotent in both
# directions. Pop after every call: EnVar always pushes a status and an
# unbalanced stack corrupts the surrounding generated script.

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\resources\agent-payload\bin\hermes.exe"
    EnVar::SetHKCU
    EnVar::AddValue "PATH" "$INSTDIR\resources\agent-payload\bin"
    Pop $0
    ${If} $0 != 0
      DetailPrint "Could not add the Hermes CLI to PATH (EnVar status $0)"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  EnVar::SetHKCU
  EnVar::DeleteValue "PATH" "$INSTDIR\resources\agent-payload\bin"
  Pop $0
!macroend
