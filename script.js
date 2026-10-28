
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";

import {
    getAuth,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

import {
    getDatabase,
    ref,
    set,
    onValue
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js";

import {
    EditorView,
    basicSetup
} from "codemirror";

import {
    EditorState,
    Compartment
} from "@codemirror/state";

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
const entrada = document.getElementById("entrada");
const botonEnviar = document.getElementById("enviar");

// REFERENCIAS COMPARTIDAS
const codigoRef = ref(db, "sala/codigo");
const consolaRef = ref(db, "sala/consola");

// ESTADO
let pyodide;
let editorView;
let ejecutando = false;
let pythonListo = false;
let capturaSalida = "";
let temporizadorGuardar;
let aplicandoCodigoRemoto = false;

const editorEditable = new Compartment();

const codigoInicial =
    'nombre = input("¿Cómo te llamas? ")\\n' +
    'print("¡Hola,", nombre, "!")\\n' +
    'print("Bienvenido a la sala.")';

// CONTROL DE PERMISOS
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

    boton.disabled =
        !puedeEditar || !pythonListo || ejecutando;

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
    } else {
        estado.textContent = "Conectado a la sala";
    }
}

nombreInput.addEventListener("input", actualizarPermisos);

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

// CREAR EDITOR Y CONECTAR FIREBASE
async function iniciarSala() {
    try {
        estado.textContent = "Conectando con Firebase...";

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

                    // Guardar los cambios locales en Firebase.
                    EditorView.updateListener.of(update => {
                        if (
                            !update.docChanged ||
                            aplicandoCodigoRemoto ||
                            !auth.currentUser ||
                            !nombreInput.value.trim()
                        ) {
                            return;
                        }

                        clearTimeout(temporizadorGuardar);

                        temporizadorGuardar = setTimeout(async () => {
                            try {
                                await set(
                                    codigoRef,
                                    editorView.state.doc.toString()
                                );
                            } catch (error) {
                                console.error(
                                    "Error guardando el código:",
                                    error
                                );
                            }
                        }, 400);
                    })
                ]
            }),
            parent: editorDiv
        });

        actualizarPermisos();

        // Recibir el código de todos los participantes.
        onValue(codigoRef, async snapshot => {
            try {
                const codigoGuardado = snapshot.val();

                // Si todavía no existe código, crear uno inicial.
                if (
                    codigoGuardado === null &&
                    auth.currentUser
                ) {
                    await set(codigoRef, codigoInicial);
                    return;
                }

                if (typeof codigoGuardado !== "string") {
                    return;
                }

                // No actualizar si el editor ya tiene ese código.
                if (
                    editorView.state.doc.toString() ===
                    codigoGuardado
                ) {
                    return;
                }

                // Aplicar el cambio remoto sin volver a guardarlo.
                aplicandoCodigoRemoto = true;

                editorView.dispatch({
                    changes: {
                        from: 0,
                        to: editorView.state.doc.length,
                        insert: codigoGuardado
                    }
                });

                aplicandoCodigoRemoto = false;

            } catch (error) {
                aplicandoCodigoRemoto = false;
                console.error(
                    "Error recibiendo el código:",
                    error
                );
            }
        }, error => {
            console.error("Error leyendo el código:", error);
            estado.textContent = "Error leyendo el código";
        });

        // Recibir los resultados de ejecución compartidos.
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
        console.error("Error conectando con Firebase:", error);
        estado.textContent = "Error de conexión";
        salida.textContent =
            "No se pudo conectar a la sala:\n" + error.message;
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

        const resultado = capturaSalida || "(Sin salida)";

        await set(consolaRef, {
            salida: resultado,
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
            console.error(
                "Error compartiendo el resultado:",
                errorFirebase
            );
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

// ARRANCAR
iniciarPython();
iniciarSala();
