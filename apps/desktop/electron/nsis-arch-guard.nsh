# Arch lock for the NSIS installers. Wired from electron-builder.config.cjs
# through nsis.include; electron-builder splices customInit into .onInit for
# the oneClick and the assisted installer.
#
# Why this exists: the stock identify_package macro
# (app-builder-lib templates/nsis/include/extractAppPackage.nsh) treats an
# arm64 machine as a valid x64 host. An x64 installer on arm64 Windows
# installs silently and the app then runs in emulation forever. The reverse
# direction is worse: an arm64 installer on an x64 machine matches no
# package macro, so the installer "succeeds" and writes an EMPTY install.
#
# The defines and the native-machine tests come from the surrounding
# electron-builder machinery: APP_64/APP_ARM64 exist per embedded payload,
# x64.nsh (included by common.nsh) supplies IsNativeAMD64/IsNativeARM64,
# which see through WOW emulation. The !ifndef nesting keeps a future
# multi-arch installer permissive: it carries both payloads, so it must
# not be blocked on either machine.
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
