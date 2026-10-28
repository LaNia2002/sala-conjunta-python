

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import { getDatabase, ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-database.js";

console.log("✅ script.js se está ejecutando");

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

const editor = document.getElementById("codigo");
const salida = document.getElementById("salida");
const boton = document.getElementById("ejecutar");
const estado = document.getElementById("estado");
const nombreInput = document.getElementById("nombre");
editor.disabled = true;
boton.disabled = true;

function actualizarPermisos() {
    const tieneNombre = nombreInput.value.trim().length > 0;

    editor.disabled = !tieneNombre;
    boton.disabled = !tieneNombre || !pyodide;

    if (!tieneNombre) {
        estado.textContent = "Escribe tu nombre para participar";
    } else {
        estado.textContent = pyodide
            ? "Listo para participar"
            : "Cargando Python...";
    }
}

nombreInput.addEventListener("input", actualizarPermisos);
const botonLimpiar = document.getElementById("limpiar");

const codigoRef = ref(db, "sala/codigo");
const consolaRef = ref(db, "sala/consola");

let pyodide;
let ejecutando = false;
let sincronizandoCodigo = false;
let temporizador = null;
let versionLocal = 0;

// ---------- PYTHON ----------

async function iniciarPython() {
    try {
        estado.textContent = "Cargando Python...";

        pyodide = await loadPyodide();

        pyodide.setStdout({
            batched: texto => {
                salida.textContent += texto + "\n";
            }
        });

        pyodide.setStderr({
            batched: texto => {
                salida.textContent += texto + "\n";
            }
        });

        pyodide.setStdin({
            stdin: () => prompt("Python solicita una entrada:") ?? ""
        });

        boton.textContent = "▶ Ejecutar";
        actualizarPermisos();
        console.log("✅ Python está listo");
    } catch (error) {
        console.error("Error al cargar Python:", error);
        estado.textContent = "Error al cargar Python";
        salida.textContent = String(error);
    }
}

// ---------- FIREBASE ----------

async function iniciarSala() {
    try {
        estado.textContent = "Conectando con Firebase...";
        console.log("🚀 Iniciando conexión con Firebase...");

        await signInAnonymously(auth);
        console.log("✅ Inicio de sesión anónimo correcto");

        const snapshot = await get(codigoRef);

        if (snapshot.val() === null) {
            await set(codigoRef, editor.value);
        } else {
            sincronizandoCodigo = true;
            editor.value = snapshot.val();
            sincronizandoCodigo = false;
        }

        onValue(codigoRef, snapshot => {
            const codigoRemoto = snapshot.val();

            if (
                typeof codigoRemoto === "string" &&
                codigoRemoto !== editor.value
            ) {
                sincronizandoCodigo = true;
                editor.value = codigoRemoto;
                sincronizandoCodigo = false;
                versionLocal++;
            }
        }, error => {
            console.error("Error leyendo el código:", error);
            estado.textContent = "Error leyendo el código";
        });

        onValue(consolaRef, snapshot => {
            const resultado = snapshot.val();

            if (resultado && typeof resultado.salida === "string") {
                salida.textContent =
                    "Ejecutado por: " + resultado.nombre +
                    "\n\n" + resultado.salida;
            }
        }, error => {
            console.error("Error leyendo la consola:", error);
        });

        estado.textContent = "Conectado a la sala";
        console.log("✅ Firebase conectado y sala inicializada");

    } catch (error) {
        console.error("Error de Firebase:", error);
        estado.textContent = "Error de conexión con Firebase";
        salida.textContent =
            "No se pudo conectar a la sala:\n" + error.message;
    }
}

// ---------- SINCRONIZAR CÓDIGO ----------

editor.addEventListener("input", () => {
    if (sincronizandoCodigo || !auth.currentUser) return;

    versionLocal++;
    const versionActual = versionLocal;

    clearTimeout(temporizador);

    temporizador = setTimeout(async () => {
        try {
            await set(codigoRef, editor.value);
            console.log("💾 Código guardado");
        } catch (error) {
            console.error("Error guardando el código:", error);
            estado.textContent = "Error guardando el código";
        }
    }, 300);
});

// ---------- EJECUTAR PYTHON ----------

boton.addEventListener("click", async () => {
    if (!pyodide || ejecutando || !auth.currentUser) return;

    ejecutando = true;
    boton.disabled = true;
    salida.textContent = "";

    try {
        await pyodide.runPythonAsync(editor.value);

        // Esperar a que terminen de escribirse las líneas de salida.
        await new Promise(resolve => setTimeout(resolve, 50));

        const resultado = salida.textContent;

        await set(consolaRef, {
            salida: resultado,
            nombre: nombreInput.value.trim() || "Anónimo",
            fecha: Date.now()
        });

        console.log("✅ Resultado compartido");
    } catch (error) {
        const mensaje = salida.textContent + String(error);
        salida.textContent = mensaje;

        try {
            await set(consolaRef, {
                salida: mensaje,
                nombre: nombreInput.value.trim() || "Anónimo",
                fecha: Date.now()
            });
        } catch (errorFirebase) {
            console.error("Error compartiendo el resultado:", errorFirebase);
        }
    } finally {
        ejecutando = false;
        boton.disabled = false;
    }
});

// ---------- LIMPIAR CONSOLA ----------

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

// ---------- INICIAR ----------

iniciarPython();
iniciarSala();
