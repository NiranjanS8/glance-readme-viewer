; Add an explicit Explorer verb and make sure Glance appears in the Open With
; list. electron-builder's fileAssociations handles the file class itself; these
; keys are per-user/per-machine according to the installer's shell context.

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
  !insertmacro GLANCE_CONTEXT_MENU ".md"
  !insertmacro GLANCE_CONTEXT_MENU ".markdown"
  !insertmacro GLANCE_CONTEXT_MENU ".mdown"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".md"
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".markdown"
  !insertmacro GLANCE_REMOVE_CONTEXT_MENU ".mdown"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
