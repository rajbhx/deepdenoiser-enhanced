# Historical test fixture

`liveModelMonitor-2.0.5-reference.txt` is a verbatim copy of the observer from the delivered 2.0.5 source, retained **only** so the desktop real-model regression can compare the current observer-free audio and recurrent state against that historical implementation. It is not imported by the application. The file contains source code, not recorded user audio.

Its SHA-256 is `774cdfa703e435ec12b8a32e15240c885e33c67db43cae772fcac47188bbec61`. The app's Live Model View and its runtime monitor have been removed; do not reintroduce the fixture into the app bundle.
