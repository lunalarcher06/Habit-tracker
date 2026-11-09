"""
Domain — Authentication.

Handles user registration and login. I used Wekzeug to hash passwords, they are never stored as plain test. 
"""

from werkzeug.security import generate_password_hash, check_password_hash

#Create user but all requirements must be met. 
def register_user(db, first_name, last_name, username, password):
    first_name = (first_name or "").strip()
    last_name = (last_name or "").strip()
    username = (username or "").strip()

    if not first_name:
        raise ValueError("first name is required")
    if not last_name:
        raise ValueError("last name is required")
    if len(username) < 3:
        raise ValueError("username must be at least 3 characters")
    if not password or len(password) < 8:
        raise ValueError("password must be at least 8 characters")

    existing = db.execute(
        "SELECT 1 AS found FROM users WHERE username = %s", (username,)
    ).fetchone()
    if existing:
        raise ValueError("username already taken")
    hashed = generate_password_hash(password, method="pbkdf2:sha256")
    cur = db.execute(
        """INSERT INTO users (first_name, last_name, username, password_hash)
           VALUES (%s, %s, %s, %s)""",
        (first_name, last_name, username, hashed),
    )
    db.commit()
    return cur.lastrowid

def authenticate_user(db, username, password):
    username = (username or "").strip()   
    user = db.execute(
        "SELECT * FROM users WHERE username = %s", (username,)
    ).fetchone()
    if user is None:
        return None
    if not check_password_hash(user["password_hash"], password):
        return None
    return user

def get_user_by_id(db, user_id):
    return db.execute(
        "SELECT * FROM users WHERE id = %s", (user_id,)
    ).fetchone()
