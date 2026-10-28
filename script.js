
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
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";

import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { python } from "@codemirror/lang-python";

// FIREBASE
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
const entrada = document.getElementById("entrada");
const botonEnviar = document.getElementById("enviar");

// FIREBASE: CÓDIGO Y CONSOLA
const codigoRef = ref(db, "sala/codigo");
const consolaRef = ref(db, "sala/consola");

// YJS + WEBSOCKET
const documento = new Y.Doc();

const proveedor = new WebsocketProvider(
    "wss://sala-conjunta-python.onrender.com",
    "sala-conjunta-python-principal",
    documento
);

const textoCompartido = documento.getText("codigo");

// ESTADO
let pyodide;
let editorView;
let ejecutando = false;
let pythonListo = false;
let capturaSalida = "";
let temporizadorGuardar;
let colaboracionLista = false;
let aplicandoCodigoInicial = false;

const editorEditable = new Compartment();

const codigoInicial =
    'nombre = input("¿Cómo te llamas? ")\\n' +
    'print("¡Hola,", nombre, "!")\\n' +
    'print("Bienvenido a la sala.")';

// PERMISOS
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
        estado.textContent = "Conectando con Firebase...";
    } else if (!tieneNombre) {
        estado.textContent = "Escribe tu nombre para participar";
    } else if (!pythonListo) {
        estado.textContent = "Cargando Python...";
    } else if (!colaboracionLista) {
        estado.textContent = "Conectando editor colaborativo...";
    } else {
        estado.textContent = "Conectado a la sala";
    }
}

nombreInput.addEventListener("input", actualizarPermisos);

// INICIAR PYTHON
async function iniciarPython() {
    try {
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

// GUARDAR COPIA DEL CÓDIGO EN FIREBASE
function guardarCopiaFirebase() {
    if (!colaboracionLista || aplicandoCodigoInicial) return;

    clearTimeout(temporizadorGuardar);

    temporizadorGuardar = setTimeout(async () => {
        try {
            await set(codigoRef, textoCompartido.toString());
        } catch (error) {
            console.error("Error guardando el código:", error);
        }
    }, 600);
}

// OBSERVAR CAMBIOS COLABORATIVOS
textoCompartido.observe(() => {
    if (editorView) {
        guardarCopiaFirebase();
    }
});

// CREAR EDITOR Y CONECTAR SERVICIOS
async function iniciarSala() {
    try {
        await signInAnonymously(auth);

        editorView = new EditorView({
            state: EditorState.create({
                doc: "",
                extensions: [
                    basicSetup,
                    python(),

                    editorEditable.of(
                        EditorView.editable.of(false)
                    ),

                    // Sincronización colaborativa mediante Yjs.
                    yCollab(textoCompartido, proveedor.awareness)
                ]
            }),
            parent: editorDiv
        });

        actualizarPermisos();

        // Estado de la conexión WebSocket.
        proveedor.on("status", ({ status }) => {
            console.log("WebSocket:", status);

            if (status === "disconnected") {
                estado.textContent = "Reconectando colaboración...";
            }

            actualizarPermisos();
        });

        // Cuando Yjs termina la sincronización inicial,
        // recuperar el código guardado si la sala está vacía.
        proveedor.on("sync", async sincronizado => {
            if (!sincronizado) return;

            colaboracionLista = true;
            actualizarPermisos();

            if (textoCompartido.length === 0) {
                try {
                    const snapshot = await get(codigoRef);
                    const guardado = snapshot.val();

                    const codigo = (
                        typeof guardado === "string" &&
                        guardado.length > 0
                    ) ? guardado : codigoInicial;

                    // Evita insertar el código si llegó contenido
                    // colaborativo mientras se consultaba Firebase.
                    if (textoCompartido.length === 0) {
                        aplicandoCodigoInicial = true;
                        textoCompartido.insert(0, codigo);
                        aplicandoCodigoInicial = false;

                        await set(codigoRef, textoCompartido.toString());
                    }
                } catch (error) {
                    aplicandoCodigoInicial = false;
                    console.error("Error recuperando el código:", error);
                }
            }

            console.log("Editor colaborativo sincronizado.");
        });

        // CONSOLA COMPARTIDA MEDIANTE FIREBASE
        onValue(consolaRef, snapshot => {
            const resultado = snapshot.val();

            if (resultado && typeof resultado.salida === "string") {
                salida.textContent =
                    "Ejecutado por: " + resultado.nombre +
                    "\n\n" + resultado.salida;
            }
        });

        console.log("Sala conectada mediante Firebase.");
    } catch (error) {
        console.error("Error conectando con la sala:", error);
        estado.textContent = "Error de conexión";
        salida.textContent = "No se pudo conectar a la sala:\n" + error.message;
    }
}

// EJECUTAR PYTHON
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

        await set(consolaRef, {
            salida: capturaSalida || "(Sin salida)",
            nombre: nombreInput.value.trim(),
            fecha: Date.now()
        });
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

// LIMPIAR CONSOLA COMPARTIDA
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

// INICIAR
iniciarPython();
iniciarSala();
