Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\Thomas\claude-home\multica-dashboard"
objShell.Run "cmd /c if not exist .state mkdir .state & node src\server.js >> .state\server.log 2>&1", 0, False
