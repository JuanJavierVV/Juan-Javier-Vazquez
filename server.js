const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // carpeta donde están los .html

// Configurar conexión a PostgreSQL
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'EKMCydhu1355', // cambia si es necesario
  port: 5432,
});

// 👉 Ruta raíz para mostrar el dashboard o login
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html'); // o login.html
});

// Registrar usuario
app.post('/registro', async (req, res) => {
  const { nombre, correo, contrasena } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, correo, contrasena) VALUES ($1, $2, $3) RETURNING *',
      [nombre, correo, contrasena]
    );
    res.json({ mensaje: 'Usuario registrado con éxito', usuario: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al registrar usuario' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { correo, contrasena } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE correo = $1 AND contrasena = $2',
      [correo, contrasena]
    );

    if (result.rows.length > 0) {
      res.json({ mensaje: 'Inicio de sesión exitoso', usuario: result.rows[0] });
    } else {
      res.json({ mensaje: 'Correo o contraseña incorrectos' });
    }
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    res.status(500).json({ mensaje: 'Error en el servidor' });
  }
});

// Agregar parada
// ... [todo lo que ya tenías arriba sin cambios] ...

// Agregar parada
app.post('/agregar-parada', async (req, res) => {
  const { nombre, latitud, longitud } = req.body;

  try {
    await pool.query(
      'INSERT INTO paradas (nombre, latitud, longitud) VALUES ($1, $2, $3)',
      [nombre, latitud, longitud]
    );
    res.json({ mensaje: 'Parada guardada correctamente' });
  } catch (error) {
    console.error('Error al guardar parada:', error);
    res.status(500).json({ mensaje: 'Error al guardar parada' });
  }
});

// 🔥 NUEVA RUTA: obtener todas las paradas
// Obtener paradas desde la base de datos
app.get('/paradas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM paradas');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener paradas:', error);
    res.status(500).json({ mensaje: 'Error al obtener paradas' });
  }
});

// Agregar o vincular un bus con un IMEI de GPS
// Agregar o vincular un bus con un IMEI de GPS
app.post('/agregar-bus', async (req, res) => {
  const { placa, imei } = req.body;

  try {
    await pool.query(
      'INSERT INTO buses (placa, imei) VALUES ($1, $2)',
      [placa, imei]
    );
    res.json({ mensaje: 'Bus vinculado correctamente' });
  } catch (error) {
    console.error('Error al vincular bus:', error);
    res.status(500).json({ mensaje: 'Error al vincular bus' });
  }
});


app.get('/buses', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM buses');
    res.json(resultado.rows);
  } catch (error) {
    console.error('Error al obtener buses:', error);
    res.status(500).json({ mensaje: 'Error al obtener la lista de buses' });
  }
});


app.delete('/buses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM buses WHERE id = $1', [id]);
    res.json({ mensaje: 'Bus eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar bus:', error);
    res.status(500).json({ error: 'Error al eliminar bus' });
  }
});

// Actualizar o insertar posición del bus (por IMEI)
app.post('/actualizar-posicion', async (req, res) => {
  const { imei, latitud, longitud } = req.body;

  try {
    // Insertar nueva posición (en esta versión guardamos cada entrada)
    await pool.query(
      'INSERT INTO posiciones (imei, latitud, longitud) VALUES ($1, $2, $3)',
      [imei, latitud, longitud]
    );
    res.json({ mensaje: 'Posición actualizada correctamente' });
  } catch (error) {
    console.error('Error al actualizar posición:', error);
    res.status(500).json({ mensaje: 'Error al actualizar posición' });
  }
});

app.get('/ultima-posicion/:imei', async (req, res) => {
  const { imei } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM posiciones WHERE imei = $1 ORDER BY timestamp DESC LIMIT 1',
      [imei]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ mensaje: 'No se encontró posición para ese IMEI' });
    }
  } catch (error) {
    console.error('Error al obtener posición:', error);
    res.status(500).json({ mensaje: 'Error en el servidor' });
  }
});

// Obtener últimas posiciones por IMEI
// Obtener la última posición de cada bus (con placa)
app.get('/posiciones', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.imei, p.latitud, p.longitud, b.placa
      FROM (
        SELECT DISTINCT ON (imei) imei, latitud, longitud, timestamp
        FROM posiciones
        ORDER BY imei, timestamp DESC
      ) AS p
      LEFT JOIN buses b ON p.imei = b.imei
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener posiciones:', error);
    res.status(500).json({ mensaje: 'Error al obtener posiciones' });
  }
});


app.post('/simular-posicion', async (req, res) => {
  const { imei, latitud, longitud } = req.body;
  const timestamp = new Date(); // Fecha y hora actual

  try {
    await pool.query(
      'INSERT INTO posiciones (imei, latitud, longitud, timestamp) VALUES ($1, $2, $3, $4)',
      [imei, latitud, longitud, timestamp]
    );
    res.json({ mensaje: 'Posición insertada correctamente' });
  } catch (error) {
    console.error('Error al insertar posición:', error);
    res.status(500).json({ mensaje: 'Error al insertar posición' });
  }
});


// Iniciar servidor
app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});
