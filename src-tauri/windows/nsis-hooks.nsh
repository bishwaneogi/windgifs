Var WindGifsShortcutIcon

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder

  StrCpy $WindGifsShortcutIcon "$INSTDIR\icons\icon.ico"
  IfFileExists "$WindGifsShortcutIcon" +2 0
    StrCpy $WindGifsShortcutIcon "$INSTDIR\${MAINBINARYNAME}.exe"

  ${If} $NoShortcutMode <> 1
    !if "${STARTMENUFOLDER}" != ""
      CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$WindGifsShortcutIcon" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    !else
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$WindGifsShortcutIcon" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !endif

    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$WindGifsShortcutIcon" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

    ; Keep the finish-page shortcut button from overwriting the explicit icon.
    StrCpy $NoShortcutMode 1
  ${EndIf}
!macroend
