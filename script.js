import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
    getAuth,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import {
    getDatabase,
    ref,
    get,
    set,
    onValue
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js";

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { yCollab } from "y-codemirror.next";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { python } from "@codemirror/lang-python";

// CONFIGURACIÓN FIREBASE
const firebaseConfig = {
    apiKey: "AIzaSyDOvQFsTQXnn8moUanXwM8ODmoyIoC2XMg",
    authDomain: "sala-conjunta-python.firebaseapp.com",
    databaseURL: "https://sala-conjunta-python-default-rtdb.firebaseio.com",
    projectId: "sala-conjunta-python",
    storageBucket: "sala-conjunta-python.firebasestorage.app",
    messagingSenderId: "58106951280",
    appId: "1:58106951280:web:3c5790f0793361fee4a6b5",
    measurementId: "G-TL8RHNRT70"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ELEMENTOS HTML
const editorDiv = document.getElementById("codigo");
const nombreInput = document.getElementById("nombre");
const estado = document.getElementById("estado");
const boton = document.getElementById("ejecutar");
const salida = document.getElementById("salida");
const botonLimpiar = document.getElementById("limpiar");

// DATOS COMPARTIDOS EN FIREBASE
const codigoRef = ref(db, "sala/codigo");
const consolaRef = ref(db, "sala/consola");

// ESTADO DEL PROGRAMA
let pyodide;
let editorView;
let ydoc;
let ytext;
let provider;

let ejecutando = false;
let temporizadorGuardar;
let capturaSalida = "";
let pythonListo = false;

const editorEditable = new Compartment();

// INICIAR PYTHON
async function iniciarPython() {
    try {
        estado.textContent = "Cargando Python...";

        pyodide = await loadPyodide();

        pyodide.setStdout({
            batched: texto => {
                capturaSalida += texto + "\n";
            }
        });

        pyodide.setStderr({
            batched: texto => {
                capturaSalida += texto + "\n";
            }
        });

        pyodide.setStdin({
            stdin: () => prompt("Python solicita una entrada:") ?? ""
        });

        pythonListo = true;
        actualizarPermisos();

        console.log("Python está listo.");
    } catch (error) {
        console.error("Error cargando Python:", error);
        estado.textContent = "Error al cargar Python";
        salida.textContent = String(error);
    }
}

// CONTROLAR SI EL USUARIO PUEDE EDITAR
function actualizarPermisos() {
    const tieneNombre = nombreInput.value.trim().length > 0;
    const puedeEditar = tieneNombre && Boolean(auth.currentUser);

    if (editorView) {
        editorView.dispatch({
            effects: editorEditable.reconfigure(
                EditorView.editable.of(puedeEditar)
            )
        });

        editorDiv.classList.toggle(
            "editor-bloqueado",
            !puedeEditar
        );
    }

    boton.disabled = !puedeEditar || !pythonListo || ejecutando;
    if (ejecutando) {
    boton.textContent = "Ejecutando...";
} else if (!pythonListo) {
    boton.textContent = "Preparando Python...";
} else {
    boton.textContent = "Ejecutar código";
}

    if (!auth.currentUser) {
        estado.textContent = "Conectando con la sala...";
    } else if (!tieneNombre) {
        estado.textContent = "Escribe tu nombre para participar";
    } else if (!pythonListo) {
        estado.textContent = "Cargando Python...";
    } else {
        estado.textContent = "Conectado a la sala";
    }

    if (provider) {
        provider.awareness.setLocalStateField("user", {
            name: nombreInput.value.trim() || "Anónimo",
            color: "#a78bfa",
            colorLight: "#a78bfa55"
        });
    }
}

nombreInput.addEventListener("input", actualizarPermisos);

// CREAR EDITOR COLABORATIVO
async function iniciarSala() {
    try {
        estado.textContent = "Conectando con Firebase...";

        await signInAnonymously(auth);

        // Documento colaborativo compartido entre participantes.
        ydoc = new Y.Doc();
        ytext = ydoc.getText("codigo-python");

        ytext.observe(() => {
    console.log(
        "Código recibido o modificado:",
        ytext.toString()
    );
});

        provider = new WebrtcProvider(
            "sala-conjunta-python-publica",
            ydoc
        );

        provider.on("status", event => {
            console.log("Estado WebRTC:", event.status);
        });

        provider.on("peers", event => {
            console.log("Usuarios conectados:", event.webrtcPeers);
        });

        provider.awareness.setLocalStateField("user", {
            name: nombreInput.value.trim() || "Anónimo",
            color: "#a78bfa",
            colorLight: "#a78bfa55"
        });

        editorView = new EditorView({
            state: EditorState.create({
                doc: ytext.toString(),
                extensions: [
                    basicSetup,
                    python(),
                    editorEditable.of(
                        EditorView.editable.of(false)
                    ),
                    yCollab(ytext, provider.awareness)
                ]
            }),
            parent: editorDiv
        });

        actualizarPermisos();

        // Guardar una copia del código en Firebase.
        // Yjs sigue siendo el responsable de combinar ediciones simultáneas.
        ytext.observe(() => {
            clearTimeout(temporizadorGuardar);

            temporizadorGuardar = setTimeout(async () => {
                try {
                    if (auth.currentUser) {
                        await set(codigoRef, ytext.toString());
                    }
                } catch (error) {
                    console.error("Error guardando una copia:", error);
                }
            }, 1500);
        });

        // Recuperar el código guardado si la sala colaborativa
        // está vacía. Esperamos para dar tiempo a sincronizar a los demás.
        setTimeout(async () => {
            try {
                const estados = Array.from(
                    provider.awareness.getStates().keys()
                );

                const lider = estados.length > 0
                    ? Math.min(...estados)
                    : null;

                if (ytext.length !== 0 ||
                    lider !== ydoc.clientID) {
                    return;
                }

                const snapshot = await get(codigoRef);

                if (ytext.length === 0) {
                    const codigoGuardado = snapshot.val();

                    const codigoInicial =
                        typeof codigoGuardado === "string"
                            ? codigoGuardado
                            : 'nombre = input("¿Cómo te llamas? ")\\n' +
                              'print("¡Hola,", nombre, "!")\\n' +
                              'print("Bienvenido a la sala.")';

                    ydoc.transact(() => {
                        ytext.insert(0, codigoInicial);
                    });
                }
            } catch (error) {
                console.error("Error recuperando el código:", error);
            }
        }, 4000);

        // Escuchar los resultados compartidos.
        onValue(consolaRef, snapshot => {
            const resultado = snapshot.val();

            if (resultado && typeof resultado.salida === "string") {
                salida.textContent =
                    "Ejecutado por: " + resultado.nombre +
                    "\n\n" + resultado.salida;
            }
        });

        estado.textContent = "Sala conectada";
        console.log("Sala colaborativa iniciada.");
    } catch (error) {
        console.error("Error conectando con Firebase:", error);
        estado.textContent = "Error de conexión";
        salida.textContent =
            "No se pudo conectar a la sala:\n" + error.message;
    }
}

// EJECUTAR PYTHON Y COMPARTIR EL RESULTADO
boton.addEventListener("click", async () => {
    if (!pyodide || !editorView || ejecutando) return;
    if (!nombreInput.value.trim() || !auth.currentUser) return;

    ejecutando = true;
    actualizarPermisos();

    capturaSalida = "";
    salida.textContent = "Ejecutando Python...";

    try {
        const codigo = editorView.state.doc.toString();

        await pyodide.runPythonAsync(codigo);

        const resultado = capturaSalida || "(Sin salida)";

        salida.textContent = resultado;

        await set(consolaRef, {
            salida: resultado,
            nombre: nombreInput.value.trim(),
            fecha: Date.now()
        });

        // Guardar también una copia del código ejecutado.
        await set(codigoRef, codigo);

    } catch (error) {
        const mensaje = capturaSalida + String(error);
        salida.textContent = mensaje;

        try {
            await set(consolaRef, {
                salida: mensaje,
                nombre: nombreInput.value.trim(),
                fecha: Date.now()
            });
        } catch (errorFirebase) {
            console.error("Error compartiendo el resultado:", errorFirebase);
        }
    } finally {
        ejecutando = false;
        actualizarPermisos();
    }
});

// LIMPIAR LA CONSOLA COMPARTIDA
botonLimpiar.addEventListener("click", async () => {
    if (!auth.currentUser) return;

    try {
        await set(consolaRef, {
            salida: "",
            nombre: nombreInput.value.trim() || "Anónimo",
            fecha: Date.now()
        });
    } catch (error) {
        console.error("Error limpiando la consola:", error);
    }
});

// ARRANCAR LOS DOS SISTEMAS
iniciarPython();
iniciarSala();
