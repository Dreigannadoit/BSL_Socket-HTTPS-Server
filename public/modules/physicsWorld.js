import * as CANNON from "cannon-es";

// Creates the physics world plus the named materials/contact materials the
// rest of the game references, and returns a helper for turning a level's
// collision meshes into static trimesh bodies.
export function createPhysicsWorld() {
    const world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0),
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = false;
    world.solver.iterations = 30;
    world.solver.tolerance = 0.00005;

    const floorMaterial = new CANNON.Material("floor");
    const wallMaterial = new CANNON.Material("wall");
    const ballMaterial = new CANNON.Material("ball");

    // Wall bounce
    const wallContact = new CANNON.ContactMaterial(wallMaterial, ballMaterial, {
        friction: 0.55,
        restitution: 0.9,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 3,
    });
    world.addContactMaterial(wallContact);

    // Floor bounce — reduced restitution vs. walls
    const floorContact = new CANNON.ContactMaterial(floorMaterial, ballMaterial, {
        friction: 0.55,
        restitution: 0.4,
        contactEquationStiffness: 1e8,
        contactEquationRelaxation: 1,
    });
    world.addContactMaterial(floorContact);

    world.defaultContactMaterial.friction = 0.55;
    world.defaultContactMaterial.restitution = 0.9;

    // Builds a static CANNON.Trimesh body from a rendered mesh's world-space
    // geometry, and picks floor vs. wall material from the node's name.
    function addTrimeshCollider(mesh) {
        mesh.updateWorldMatrix(true, false);
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);

        const posAttr = geometry.attributes.position;
        const vertices = Array.from(posAttr.array);

        let indices;
        if (geometry.index) {
            indices = Array.from(geometry.index.array);
        } else {
            indices = [];
            for (let i = 0; i < posAttr.count; i++) indices.push(i);
        }

        const shape = new CANNON.Trimesh(vertices, indices);

        const isFloor = /floor/i.test(mesh.name);
        const bodyMaterial = isFloor ? floorMaterial : wallMaterial;

        const body = new CANNON.Body({ mass: 0, material: bodyMaterial });
        body.addShape(shape);
        world.addBody(body);
        // Returned so callers that need to toggle this collider later (e.g.
        // GameModeManager removing/re-adding StartTrigger's solid body as
        // the player picks/leaves a game mode) don't have to track it
        // themselves.
        return body;
    }

    return { world, floorMaterial, wallMaterial, ballMaterial, addTrimeshCollider };
}
