; Add an explicit Explorer verb and make sure Glance appears in the Open With
; list. electron-builder's fileAssociations handles the file class itself; these
; keys are per-user/per-machine according to the installer's shell context.

!include LogicLib.nsh

!macro GLANCE_REGISTER_APPLICATION
  ; Windows names an app in Open With from FriendlyAppName when this key exists,
  ; even if the executable's FileDescription says something else.
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe" "FriendlyAppName" "Glance"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\Application" "ApplicationName" "Glance"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\Application" "ApplicationIcon" "$INSTDIR\Glance.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\Application" "ApplicationCompany" "NiranjanS8"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\DefaultIcon" "" "$INSTDIR\Glance.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\shell\open\command" "" '"$INSTDIR\Glance.exe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\SupportedTypes" ".md" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Glance.exe\SupportedTypes" ".mdown" ""
!macroend

!macro GLANCE_REMOVE_STALE_ELECTRON EXT
  ; Development launches used to leave electron.exe in the per-user Open With
  ; list, where Windows displayed it as "Electron". Remove that entry.
  StrCpy $0 0
  ${Do}
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithList" $0
    ${If} $1 == ""
      ${ExitDo}
    ${EndIf}
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithList" "$1"
    ${If} $2 == "electron.exe"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithList" "$1"
    ${Else}
      IntOp $0 $0 + 1
    ${EndIf}
  ${Loop}
!macroend

!macro GLANCE_CONTEXT_MENU EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\${EXT}\shell\Glance" "" "Open with Glance"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\${EXT}\shell\Glance" "Icon" "$INSTDIR\Glance.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\${EXT}\shell\Glance\command" "" '"$INSTDIR\Glance.exe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Glance.Markdown" ""
!macroend

!macro GLANCE_REMOVE_CONTEXT_MENU EXT
  DeleteRegKey SHELL_CONTEXT "Software\Classes\SystemFileAssociations\${EXT}\shell\Glance"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Glance.Markdown"
!macroend

!macro customInstall
  !insertmacro GLANCE_REGISTER_APPLICATION
  !insertmacro GLANCE_REMOVE_STALE_ELECTRON ".md"
  !insertmacro GLANCE_REMOVE_STALE_ELECTRON ".markdown"
  !insertmacro GLANCE_REMOVE_STALE_ELECTRON ".mdown"
  !insertmacro GLANCE_CONTEXT_MENU ".md"
  !insertmacro GLANCE_CONTEXT_MENU ".markdown"
  !insertmacro GLANCE_CONTEXT_MENU ".mdown"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".md"
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".markdown"
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".mdown"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\Glance.exe"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend